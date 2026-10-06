// 文档格式转换 · 纯逻辑单测（Node 直接跑，无需 Electron / LibreOffice；挂 npm test）
// 覆盖：扩展名与家族清单一致性、智能目标选择（含教务系统「假 .xls」的扩展名场景）、
//       强制目标的拒绝矩阵（跨家族 / 同扩展名）、PDF 全支持、下拉回退与文案函数。
import assert from 'node:assert/strict';
import {
  DOC_EXTS, FAMILY_OF, AUTO_TARGET, TARGETS, targetOf,
  planOne, formatMeta, formatSize, baseNameOf
} from '../src/tools/doc-convert/core/plan.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass += 1; console.log(`  ✓ ${name}`); })
    .catch((err) => { fail += 1; failures.push({ name, message: err.message }); console.log(`  ✗ ${name}\n      ${err.message}`); });
}

console.log('文档格式转换 · 纯逻辑单测');

await test('清单一致性：DOC_EXTS 每一项都有家族定义，且双向完全一致', () => {
  for (const ext of DOC_EXTS) assert.ok(FAMILY_OF[ext], `${ext} 缺家族定义`);
  assert.deepEqual(Object.keys(FAMILY_OF).sort(), [...DOC_EXTS].sort());
});

await test('清单覆盖老格式与新格式（含「假 .xls」扩展名场景）', () => {
  for (const ext of ['.doc', '.xls', '.ppt', '.pps', '.rtf', '.docx', '.xlsx', '.pptx']) {
    assert.ok(DOC_EXTS.includes(ext), `缺 ${ext}`);
  }
  assert.ok(AUTO_TARGET['.xls'] === 'xlsx', '假 .xls 智能目标必须是 xlsx');
});

await test('智能模式：老格式 → 对应新格式', () => {
  assert.equal(planOne('.xls', { target: 'auto' }).target, 'xlsx');
  assert.equal(planOne('.xls', { target: 'auto' }).ext, '.xlsx');
  assert.equal(planOne('.doc', { target: 'auto' }).target, 'docx');
  assert.equal(planOne('.rtf', { target: 'auto' }).target, 'docx');
  assert.equal(planOne('.ppt', { target: 'auto' }).target, 'pptx');
  assert.equal(planOne('.pps', { target: 'auto' }).target, 'pptx');
});

await test('智能模式：已是新格式 → 明确提示无需转换', () => {
  for (const ext of ['.docx', '.xlsx', '.pptx']) {
    const r = planOne(ext, { target: 'auto' });
    assert.equal(r.ok, false, `${ext} 智能模式不应再转`);
    assert.match(r.reason, /无需转换/);
  }
});

await test('强制目标：同家族允许（xls→xlsx、doc→docx）', () => {
  const r = planOne('.xls', { target: 'xlsx' });
  assert.equal(r.ok, true);
  assert.equal(r.ext, '.xlsx');
  assert.equal(planOne('.doc', { target: 'docx' }).ok, true);
});

await test('强制目标：跨家族拒绝并给可读原因', () => {
  for (const [ext, mode] of [['.xls', 'docx'], ['.doc', 'pptx'], ['.ppt', 'xlsx'], ['.rtf', 'xlsx']]) {
    const r = planOne(ext, { target: mode });
    assert.equal(r.ok, false, `${ext}→${mode} 应被拒绝`);
    assert.match(r.reason, /不是同一类文档/);
  }
});

await test('强制目标：与输入扩展名相同 → 无需转换', () => {
  for (const [ext, mode] of [['.docx', 'docx'], ['.xlsx', 'xlsx'], ['.pptx', 'pptx']]) {
    const r = planOne(ext, { target: mode });
    assert.equal(r.ok, false, `${ext}→${mode} 应被拒绝`);
    assert.match(r.reason, /无需转换/);
  }
});

await test('强制 PDF：所有支持的扩展名都允许', () => {
  for (const ext of DOC_EXTS) {
    const r = planOne(ext, { target: 'pdf' });
    assert.equal(r.ok, true, `${ext}→pdf 应允许`);
    assert.equal(r.ext, '.pdf');
  }
});

await test('未知扩展名（含 WPS 私有的 .wps/.et）拒绝', () => {
  for (const ext of ['.txt', '.wps', '.et', '.dps', '.csv']) {
    assert.equal(planOne(ext, { target: 'auto' }).ok, false, ext);
  }
});

await test('targetOf：未知值回退智能模式；下拉非 auto 值与引擎 target 白名单对齐', () => {
  assert.equal(targetOf('不存在的值').value, 'auto');
  assert.equal(targetOf('pdf').label.includes('PDF'), true);
  const engineTargets = new Set(['pdf', 'docx', 'xlsx', 'pptx']); // main.js libreoffice:convert 的白名单
  for (const t of TARGETS) {
    if (t.value !== 'auto') assert.ok(engineTargets.has(t.value), `${t.value} 不在引擎白名单`);
  }
});

await test('文案：formatMeta / formatSize / baseNameOf', () => {
  assert.match(formatMeta('.xls'), /转 \.xlsx/);
  assert.match(formatMeta('.docx'), /已是新格式/);
  assert.equal(formatSize(2048), '2.0 KB');
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB');
  assert.equal(baseNameOf('C:\\a\\b\\名单.xls'), '名单.xls');
  assert.equal(baseNameOf('/tmp/名单.xls'), '名单.xls');
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) {
  console.error('失败明细：', JSON.stringify(failures, null, 2));
  process.exit(1);
}
