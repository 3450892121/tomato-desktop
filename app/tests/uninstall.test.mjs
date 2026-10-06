// 软件卸载·纯逻辑单测（npm test 连跑；也可单独 `node tests/uninstall.test.mjs`）
// 被测对象：src/tools/uninstall/core/launch.mjs —— 提权启动脚本的拼装与执行结果解读。
// 重点盯「中文/空格/单引号路径不能拼坏命令」「取消与失败要分得清」这两类会直接影响用户的事。
import fs from 'node:fs';
import {
  EXE_NAME, VERSION_FILE, powershellPath, psQuote, buildRunAsScript, interpretLaunchResult, describeAddonStatus
} from '../src/tools/uninstall/core/launch.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push({ name, message: detail === undefined ? '断言为假' : String(detail) });
}

// ① 单引号字面量：内部单引号翻倍，中文与空格原样保留
{
  check('普通路径加引号', psQuote('C:\\a b\\c.exe') === "'C:\\a b\\c.exe'", psQuote('C:\\a b\\c.exe'));
  check('单引号被翻倍', psQuote("C:\\a'b\\c.exe") === "'C:\\a''b\\c.exe'", psQuote("C:\\a'b\\c.exe"));
  check('中文路径原样', psQuote('C:\\番茄混淆\\addons\\hibit') === "'C:\\番茄混淆\\addons\\hibit'", psQuote('C:\\番茄混淆\\addons\\hibit'));
}

// ② 提权脚本：RunAs 结尾、带工作目录、不给对方传任何参数
{
  const s = buildRunAsScript({ exePath: 'C:\\soft wear\\HiBitUninstaller-Portable.exe', workingDir: 'C:\\soft wear' });
  check('脚本以 -Verb RunAs 结尾', /-Verb RunAs$/.test(s), s);
  check('脚本带 -WorkingDirectory', s.includes("-WorkingDirectory 'C:\\soft wear'"), s);
  check('脚本不传额外参数给目标程序', !/-Argument[List]?\b/.test(s), s);
  check('缺工作目录时不报错', buildRunAsScript({ exePath: 'C:\\x.exe' }).endsWith('-FilePath \'C:\\x.exe\' -Verb RunAs'), buildRunAsScript({ exePath: 'C:\\x.exe' }));
}

// ③ 结果解读三态：成功 / 用户取消（不是错误）/ 真失败（要带原因）
{
  const okRes = interpretLaunchResult({ status: 0 });
  check('退出码 0 → 成功', okRes.ok === true, JSON.stringify(okRes));

  const cancelEn = interpretLaunchResult({ status: 1, stderr: 'Start-Process : This operation has been canceled by the user.' });
  check('英文取消 → canceled', cancelEn.ok === false && cancelEn.canceled === true, JSON.stringify(cancelEn));
  const cancelZh = interpretLaunchResult({ status: 1, stderr: '操作已被用户取消。' });
  check('中文取消 → canceled', cancelZh.ok === false && cancelZh.canceled === true, JSON.stringify(cancelZh));

  const bad = interpretLaunchResult({ status: 1, stderr: 'line1\r\nline2: 找不到文件' });
  check('失败 → 取最后一行原因', bad.ok === false && bad.canceled === undefined && /找不到文件/.test(bad.message), JSON.stringify(bad));
  const empty = interpretLaunchResult({ status: 5 });
  check('无输出 → 用退出码兜底', /退出码 5/.test(empty.message), JSON.stringify(empty));
}

// ④ 常量与状态描述：名字/版本文件与加装包约定一致；缺失时如实说「没找到」
{
  check('exe 名保持官方原名', EXE_NAME === 'HiBitUninstaller-Portable.exe', EXE_NAME);
  check('版本文件名', VERSION_FILE === '版本.txt', VERSION_FILE);

  const missing = describeAddonStatus({ found: false, dir: 'C:\\x\\addons\\hibit' });
  check('缺失 → found=false 且 ok=false', missing.found === false && missing.ok === false, JSON.stringify(missing));
  const found = describeAddonStatus({ found: true, exePath: 'C:\\x\\a.exe', dir: 'C:\\x', version: ' 4.0.10\n' });
  check('找到 → 路径与版本就位（版本去空白）', found.found === true && found.path === 'C:\\x\\a.exe' && found.version === '4.0.10', JSON.stringify(found));
}

// ⑤ PowerShell 绝对路径：本机必须存在（否则提权启动会 ENOENT——pack.js 曾踩过同款坑）
{
  const ps = powershellPath();
  check('PowerShell 路径是绝对路径且指向 System32', /System32[\\/]WindowsPowerShell/i.test(ps) && /^[A-Za-z]:\\/.test(ps), ps);
  check('PowerShell 在本机存在', fs.existsSync(ps), ps);
  check('可用环境变量覆盖根目录', powershellPath({ SystemRoot: 'D:\\Win' }).startsWith('D:\\Win\\System32'), powershellPath({ SystemRoot: 'D:\\Win' }));
}

console.log(`\n软件卸载逻辑：通过 ${pass} / 共 ${pass + fail}${fail ? `（失败 ${fail}）` : ''}`);
for (const f of failures) console.log(`  ✗ ${f.name}：${f.message}`);
process.exit(fail === 0 ? 0 : 1);