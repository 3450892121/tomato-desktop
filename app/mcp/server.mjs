#!/usr/bin/env node
// 番茄工具箱 · MCP server（stdio 传输）
//
// 目标：让支持 MCP 的 agent（DSH / Claude Desktop / Qoder / Trae 等）直接调用
// 本软件的本地能力，而不需要开 GUI。第一批只注册纯 Node 工具：
//   图片混淆、文件藏图、压缩/解压、PDF 组装、批量重命名。
//
// 协议：JSON-RPC 2.0，一行一条消息（MCP stdio 传输）。
// 重要：stdout 只能输出协议消息；所有日志走 stderr，否则客户端会解析失败。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { tools, findTool, publicToolList, isReadOnlyMode } from './tools/index.mjs';
import { jsonResult, errorResult } from './lib/result.mjs';
import { userdataDir } from './lib/paths.mjs';

const SERVER_INFO = { name: 'tomato-toolbox', version: '2.14.1' };
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const AUDIT_FILE = path.join(userdataDir(), 'mcp-audit.jsonl');
let clientInfo = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(...args) {
  console.error('[tomato-mcp]', ...args);
}

function rpcError(id, code, message) {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

/** 递归脱敏：密码/密钥/token 字段不写进审计日志 */
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /password|secret|token/i.test(k) ? '***' : redact(v);
    }
    return out;
  }
  return value;
}

/** 审计日志：谁在什么时候调了什么、成没成、用了多久；不记录输出正文 */
function writeAudit(record) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    const line = JSON.stringify({ ...record, client: clientInfo || null });
    fs.appendFileSync(AUDIT_FILE, `${line.slice(0, 8000)}\n`, 'utf8');
  } catch (err) {
    log('audit write failed:', String((err && err.message) || err));
  }
}

function summarizeResult(result) {
  if (!result || !result.structuredContent) return {};
  const s = result.structuredContent;
  const out = { ok: s.ok };
  if (s.output) out.output = s.output;
  if (Array.isArray(s.outputs)) out.outputs = s.outputs.length;
  if (s.message) out.message = String(s.message).slice(0, 300);
  return out;
}

async function handleRequest(msg) {
  const { id, method, params } = msg || {};

  if (method === 'initialize') {
    const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : '2024-11-05';
    clientInfo = params && params.clientInfo ? params.clientInfo : null;
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      }
    });
    return;
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: publicToolList() } });
    return;
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const tool = findTool(name);
    if (!tool) {
      const message = isReadOnlyMode()
        ? `只读模式下不允许调用写工具：${name}`
        : `未知工具：${name}`;
      writeAudit({ ts: startedAt, tool: name, args: redact(args), ok: false, ms: Date.now() - t0, error: message });
      send({ jsonrpc: '2.0', id, result: errorResult(message) });
      return;
    }
    try {
      const value = await tool.handler(args);
      // 允许工具自己返回完整 MCP 结果（带 content），否则统一包成 JSON
      const result = value && Array.isArray(value.content) ? value : jsonResult(value);
      writeAudit({
        ts: startedAt, tool: name, args: redact(args),
        ok: !result.isError, ms: Date.now() - t0, ...summarizeResult(result)
      });
      send({ jsonrpc: '2.0', id, result });
    } catch (err) {
      const message = String((err && err.message) || err || '工具执行失败');
      log(`tool ${name} failed:`, message);
      writeAudit({ ts: startedAt, tool: name, args: redact(args), ok: false, ms: Date.now() - t0, error: message });
      send({ jsonrpc: '2.0', id, result: errorResult(message) });
    }
    return;
  }

  // 通知类消息没有 id，不需要回复
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;

  if (method === 'resources/list') {
    send({ jsonrpc: '2.0', id, result: { resources: [] } });
    return;
  }
  if (method === 'prompts/list') {
    send({ jsonrpc: '2.0', id, result: { prompts: [] } });
    return;
  }

  if (id !== undefined) rpcError(id, -32601, `Method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const text = String(line || '').trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    rpcError(null, -32700, 'Parse error');
    return;
  }
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    rpcError(msg && msg.id, -32600, 'Invalid Request');
    return;
  }
  Promise.resolve()
    .then(() => handleRequest(msg))
    .catch((err) => {
      log('unhandled:', err);
      if (msg.id !== undefined) rpcError(msg.id, -32603, String((err && err.message) || err));
    });
});

rl.on('close', () => {
  log(`stdin closed; ${tools.length} tools registered`);
});

process.on('unhandledRejection', (err) => log('unhandledRejection:', err));
process.on('uncaughtException', (err) => log('uncaughtException:', err));

log(`server started; ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);
