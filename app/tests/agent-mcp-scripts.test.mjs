// 一键接入 / 移除脚本的回归测试（纯 Node，不需要 Electron 界面）
// 运行：cd app && node tests/agent-mcp-scripts.test.mjs（已挂进 npm test）
//
// 为什么要有它：这两个脚本会改用户自己的配置（~/.dsh、~/.qoder-cn）。
// 线上手工点一遍容易漏，这里在临时目录里模拟真实配置，逐条锁死：
//   · 只动自己那一条，其它 MCP / providers / 注释必须原样保留；
//   · 重复接入不重复写、备份不互相覆盖；
//   · 移除要删干净（含 Skill），再移除一次要友好退出；
//   · 配置坏了必须拒绝改动，不能写坏用户文件；
//   · 写出来的配置要真的能把 MCP 拉起来并列出工具。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const TOOLS = path.join(APP, 'tools');
const PS = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';

let pass = 0;
let fail = 0;
const lines = [];
const roots = [];

function tempRoot(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tomato-agent-${tag}-`));
  roots.push(dir);
  return dir;
}

async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    lines.push(`  ✅ ${name}`);
  } catch (err) {
    fail += 1;
    lines.push(`  ❌ ${name}\n       ${(err && err.stack) || err}`);
  }
}

function runScript(script, args) {
  const res = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(TOOLS, script), ...args], {
    encoding: 'utf8',
    windowsHide: true
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function read(p) { return fs.readFileSync(p, 'utf8'); }

function listBackups(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.startsWith(prefix));
}

const DSH_SCRIPT = 'setup-dsh-mcp.ps1';
const DSH_UNINSTALL = 'uninstall-dsh-mcp.ps1';
const QODER_SCRIPT = 'setup-qoder-mcp.ps1';
const QODER_UNINSTALL = 'uninstall-qoder-mcp.ps1';

const ORIGINAL_DSH = [
  '# 用户自己的补丁层（中文注释要原样保留）',
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config:',
  '    provider: deepseek-account',
  '    model: deepseek-flash',
  '- insert:',
  '    - id: memory-jiyi-zhishiku',
  '      name: "@deepseek-ai/dsh-mcp-client"',
  '      config:',
  '        serverName: jiyi-zhishiku',
  '        transport: streamable-http',
  '        url: "http://127.0.0.1:8791/mcp"',
  ''
].join('\n');

const ORIGINAL_QODER = JSON.stringify({
  enabledPlugins: { 'qoder-context@qoderapp-bundler': true },
  mcpServers: { GitHub: { url: 'https://api.githubcopilot.com/mcp/', type: 'http' } },
  providers: { custom: { baseUrl: 'https://example.com', apiKey: 'ark-test', models: [{ model: 'glm-5.3-flash' }] } },
  note: '说明文字：中文保留测试'
}, null, 2);

function makeDshRoot() {
  const root = tempRoot('dsh');
  const dsh = path.join(root, '.dsh');
  fs.mkdirSync(path.join(dsh, 'profiles', 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(dsh, 'profiles', 'desktop', 'cordis.patch.yml'), ORIGINAL_DSH, 'utf8');
  return dsh;
}

function makeQoderRoot() {
  const root = tempRoot('qoder');
  const qoder = path.join(root, '.qoder-cn');
  fs.mkdirSync(qoder, { recursive: true });
  fs.writeFileSync(path.join(qoder, 'settings.json'), ORIGINAL_QODER, 'utf8');
  return qoder;
}

const dshConfig = (dsh) => path.join(dsh, 'profiles', 'desktop', 'cordis.patch.yml');
const dshSkill = (dsh) => path.join(dsh, 'skills', 'tomato-toolbox');
const qoderConfig = (q) => path.join(q, 'settings.json');
const qoderSkill = (q) => path.join(q, 'skills', 'tomato-toolbox');

// 用生成的配置真的拉起 MCP，确认能列出工具
function probeEntry(entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(entry.command, entry.args, {
      cwd: entry.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...(entry.env || {}) }
    });
    let buf = '';
    let stderr = '';
    const pending = new Map();
    let nextId = 1;
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('probe timeout')); }, 25000);
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      for (;;) {
        const i = buf.indexOf('\n');
        if (i < 0) break;
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || 'json-rpc error'));
          else p.resolve(msg.result);
        }
      }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    const req = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { resolve: res, reject: rej });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    (async () => {
      await req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const list = await req('tools/list', {});
      clearTimeout(timer);
      child.stdin.end();
      try { child.kill(); } catch {}
      resolve({ count: list.tools.length, stderr });
    })().catch((err) => { clearTimeout(timer); try { child.kill(); } catch {} reject(err); });
  });
}

await test('DSH：接入只追加自己的块，用户的配置与中文注释原样保留', () => {
  const dsh = makeDshRoot();
  const r = runScript(DSH_SCRIPT, ['-AppDir', APP, '-DshRoot', dsh]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const text = read(dshConfig(dsh));
  assert.match(text, /# >>> tomato-toolbox-mcp/);
  assert.match(text, /# <<< tomato-toolbox-mcp/);
  assert.match(text, /serverName: tomato-toolbox/);
  assert.match(text, /transport: stdio/);
  assert.ok(text.includes('# 用户自己的补丁层（中文注释要原样保留）'), '中文注释被改了');
  assert.ok(text.includes('memory-jiyi-zhishiku'), '用户已有的 MCP 条目被删了');
  assert.ok(fs.existsSync(path.join(dshSkill(dsh), 'SKILL.md')), 'Skill 没装上');
});

await test('DSH：重复接入幂等（只有一个块），备份不互相覆盖', () => {
  const dsh = makeDshRoot();
  assert.equal(runScript(DSH_SCRIPT, ['-AppDir', APP, '-DshRoot', dsh]).status, 0);
  assert.equal(runScript(DSH_SCRIPT, ['-AppDir', APP, '-DshRoot', dsh]).status, 0);
  const text = read(dshConfig(dsh));
  assert.equal((text.match(/- insert:/g) || []).length, 2, '用户原本 1 个 + 番茄 1 个');
  assert.equal((text.match(/serverName: tomato-toolbox/g) || []).length, 1);
  const backups = listBackups(path.dirname(dshConfig(dsh)), 'cordis.patch.yml.tomato-backup-');
  assert.ok(backups.length >= 2, `备份应≥2 份，实际 ${backups.length}`);
  const skillBackups = fs.readdirSync(path.join(dsh, 'skill-backups')).filter((n) => n.startsWith('tomato-toolbox-'));
  assert.ok(skillBackups.length >= 1, '旧 Skill 没备份');
});

await test('DSH：移除删块 + 删 Skill，用户的配置还在', () => {
  const dsh = makeDshRoot();
  assert.equal(runScript(DSH_SCRIPT, ['-AppDir', APP, '-DshRoot', dsh]).status, 0);
  const r = runScript(DSH_UNINSTALL, ['-DshRoot', dsh]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const text = read(dshConfig(dsh));
  assert.ok(!text.includes('tomato-toolbox-mcp'), '配置块没删干净');
  assert.ok(text.includes('memory-jiyi-zhishiku'), '误删了用户其它 MCP');
  assert.ok(!fs.existsSync(dshSkill(dsh)), 'Skill 没删');
  const skillBackups = fs.readdirSync(path.join(dsh, 'skill-backups')).filter((n) => n.startsWith('tomato-toolbox-'));
  assert.ok(skillBackups.length >= 1, 'Skill 删除前应该留备份');
});

await test('DSH：再移除一次 / 没装 DSH 都友好退出（exit 0）', () => {
  const dsh = makeDshRoot();
  assert.equal(runScript(DSH_UNINSTALL, ['-DshRoot', dsh]).status, 0);
  const missing = path.join(tempRoot('dsh-missing'), '.dsh');
  assert.equal(runScript(DSH_UNINSTALL, ['-DshRoot', missing]).status, 0);
});

await test('Qoder：接入只加 tomato-toolbox，其它 MCP / providers / 中文不动', () => {
  const qoder = makeQoderRoot();
  const r = runScript(QODER_SCRIPT, ['-AppDir', APP, '-QoderRoot', qoder]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const json = JSON.parse(read(qoderConfig(qoder)));
  assert.ok(json.mcpServers['tomato-toolbox'], '条目没写进去');
  assert.equal(json.mcpServers['tomato-toolbox'].type, 'stdio');
  assert.equal(json.mcpServers.GitHub.url, 'https://api.githubcopilot.com/mcp/', '其它 MCP 被改了');
  assert.equal(json.providers.custom.apiKey, 'ark-test', 'providers 被改了');
  assert.equal(json.note, '说明文字：中文保留测试', '中文被转义/改坏');
  assert.ok(fs.existsSync(path.join(qoderSkill(qoder), 'SKILL.md')), 'Skill 没装上');
});

await test('Qoder：重复接入幂等，备份不互相覆盖', () => {
  const qoder = makeQoderRoot();
  assert.equal(runScript(QODER_SCRIPT, ['-AppDir', APP, '-QoderRoot', qoder]).status, 0);
  assert.equal(runScript(QODER_SCRIPT, ['-AppDir', APP, '-QoderRoot', qoder]).status, 0);
  const json = JSON.parse(read(qoderConfig(qoder)));
  assert.equal(Object.keys(json.mcpServers).filter((k) => k === 'tomato-toolbox').length, 1);
  const backups = listBackups(qoder, 'settings.json.tomato-backup-');
  assert.ok(backups.length >= 2, `备份应≥2 份，实际 ${backups.length}`);
});

await test('Qoder：移除删条目 + 删 Skill，其它配置还在', () => {
  const qoder = makeQoderRoot();
  assert.equal(runScript(QODER_SCRIPT, ['-AppDir', APP, '-QoderRoot', qoder]).status, 0);
  const r = runScript(QODER_UNINSTALL, ['-QoderRoot', qoder]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const json = JSON.parse(read(qoderConfig(qoder)));
  assert.equal(json.mcpServers['tomato-toolbox'], undefined, '条目没删');
  assert.equal(json.mcpServers.GitHub.url, 'https://api.githubcopilot.com/mcp/', '误删其它 MCP');
  assert.ok(!fs.existsSync(qoderSkill(qoder)), 'Skill 没删');
});

await test('Qoder：配置是坏 JSON 时拒绝改动，文件一个字节都不变', () => {
  const root = tempRoot('qoder-bad');
  const qoder = path.join(root, '.qoder-cn');
  fs.mkdirSync(qoder, { recursive: true });
  const bad = '{ "mcpServers": { oops';
  fs.writeFileSync(qoderConfig(qoder), bad, 'utf8');
  const r = runScript(QODER_SCRIPT, ['-AppDir', APP, '-QoderRoot', qoder]);
  assert.notEqual(r.status, 0, '坏 JSON 应该拒绝');
  assert.equal(read(qoderConfig(qoder)), bad, '用户文件被改了');
  assert.ok(!fs.existsSync(qoderSkill(qoder)), '拒绝时不该装 Skill');
});

await test('Qoder：mcpServers 不是对象时拒绝改动', () => {
  const root = tempRoot('qoder-array');
  const qoder = path.join(root, '.qoder-cn');
  fs.mkdirSync(qoder, { recursive: true });
  const bad = '{ "mcpServers": [1,2,3] }';
  fs.writeFileSync(qoderConfig(qoder), bad, 'utf8');
  const r = runScript(QODER_SCRIPT, ['-AppDir', APP, '-QoderRoot', qoder]);
  assert.notEqual(r.status, 0);
  assert.equal(read(qoderConfig(qoder)), bad);
});

await test('Qoder：没有 settings.json 时能新建', () => {
  const root = tempRoot('qoder-new');
  const qoder = path.join(root, '.qoder-cn');
  fs.mkdirSync(qoder, { recursive: true });
  assert.equal(runScript(QODER_SCRIPT, ['-AppDir', APP, '-QoderRoot', qoder]).status, 0);
  const json = JSON.parse(read(qoderConfig(qoder)));
  assert.ok(json.mcpServers['tomato-toolbox']);
});

await test('写出来的 Qoder 配置能真的拉起 MCP 并列出工具', async () => {
  const qoder = makeQoderRoot();
  assert.equal(runScript(QODER_SCRIPT, ['-AppDir', APP, '-QoderRoot', qoder]).status, 0);
  const json = JSON.parse(read(qoderConfig(qoder)));
  const entry = json.mcpServers['tomato-toolbox'];
  const result = await probeEntry(entry);
  assert.equal(result.count, 41, `工具数应为 41，实际 ${result.count}`);
});

console.log(lines.join('\n'));
console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`);

for (const dir of roots) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

if (fail > 0) process.exit(1);
