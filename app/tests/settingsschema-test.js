// 设置键白名单 / 值校验 / HTML 转义 · 纯逻辑单测（Node 直接跑，无需界面与 Electron）
// 运行：cd app && node tests/settingsschema.test.mjs   （或 npm test）
//
// 覆盖：键清单与 DEFAULT_SETTINGS 不漂移、各键合法/非法值判定、导入挑选
// （未知键忽略、非法值跳过并上报、原型污染键不进 patch）、escapeHtml。
import assert from 'node:assert/strict';
import { KNOWN_SETTINGS_KEYS, validateSettingValue, pickImportableSettings } from '../src/shared/settings-schema.mjs';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';
import { escapeHtml } from '../src/shared/htmlescape.js';

/**
 * 跑全部纯逻辑单测
 * @returns {{pass:number, fail:number, total:number, failures:Array<{name:string,message:string}>}}
 */
export function runSchemaUnitTests() {
  let pass = 0;
  let fail = 0;
  const failures = [];

  function test(name, fn) {
    try {
      fn();
      pass += 1;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      fail += 1;
      failures.push({ name, message: err.message });
      console.log(`  ✗ ${name}\n      ${err.message}`);
    }
  }

  console.log('设置校验与转义 · 纯逻辑单测');

  // —— 1) 键清单与 DEFAULT_SETTINGS 完全一致（防双头维护漂移） ——
  test('KNOWN_SETTINGS_KEYS 与 DEFAULT_SETTINGS 的键一致', () => {
    assert.deepEqual([...KNOWN_SETTINGS_KEYS].sort(), Object.keys(DEFAULT_SETTINGS).sort());
  });

  // —— 2) 各键合法值 ——
  test('blockSize 合法：2 / 32 / 256', () => {
    assert.equal(validateSettingValue('blockSize', 2).ok, true);
    assert.equal(validateSettingValue('blockSize', 32).ok, true);
    assert.equal(validateSettingValue('blockSize', 256).ok, true);
  });
  test('blockSize 非法：越界 / 小数 / 字符串', () => {
    assert.equal(validateSettingValue('blockSize', 1).ok, false);
    assert.equal(validateSettingValue('blockSize', 257).ok, false);
    assert.equal(validateSettingValue('blockSize', 32.5).ok, false);
    assert.equal(validateSettingValue('blockSize', '32').ok, false);
  });
  test('jpegQuality 合法：1 / 95 / 100；非法：0 / 101 / 字符串', () => {
    assert.equal(validateSettingValue('jpegQuality', 1).ok, true);
    assert.equal(validateSettingValue('jpegQuality', 95).ok, true);
    assert.equal(validateSettingValue('jpegQuality', 100).ok, true);
    assert.equal(validateSettingValue('jpegQuality', 0).ok, false);
    assert.equal(validateSettingValue('jpegQuality', 101).ok, false);
    assert.equal(validateSettingValue('jpegQuality', '95').ok, false);
  });
  test('defaultDoubleKey 合法：字符串形式的开区间小数', () => {
    assert.equal(validateSettingValue('defaultDoubleKey', '0.666').ok, true);
    assert.equal(validateSettingValue('defaultDoubleKey', '0.5').ok, true);
    assert.equal(validateSettingValue('defaultDoubleKey', '0.999999').ok, true);
  });
  test('defaultDoubleKey 非法：数值类型 / 闭区间外 / 非数字', () => {
    assert.equal(validateSettingValue('defaultDoubleKey', 0.5).ok, false); // 必须是字符串（界面输入框即文本）
    assert.equal(validateSettingValue('defaultDoubleKey', '0').ok, false);
    assert.equal(validateSettingValue('defaultDoubleKey', '1').ok, false);
    assert.equal(validateSettingValue('defaultDoubleKey', 'abc').ok, false);
    assert.equal(validateSettingValue('defaultDoubleKey', '').ok, false);
  });
  test('outputDir 合法：任意字符串（含空串与带特殊字符的路径）', () => {
    assert.equal(validateSettingValue('outputDir', '').ok, true);
    assert.equal(validateSettingValue('outputDir', 'D:\\图片 & <导出>').ok, true); // 路径本来就可能含这些字符
  });
  test('outputDir 非法：非字符串', () => {
    assert.equal(validateSettingValue('outputDir', 123).ok, false);
    assert.equal(validateSettingValue('outputDir', null).ok, false);
  });
  test('askSavePath 合法：布尔；非法：其它', () => {
    assert.equal(validateSettingValue('askSavePath', true).ok, true);
    assert.equal(validateSettingValue('askSavePath', false).ok, true);
    assert.equal(validateSettingValue('askSavePath', 'yes').ok, false);
    assert.equal(validateSettingValue('askSavePath', 1).ok, false);
  });
  test('collapsedGroups 合法：null 或字符串数组；非法：字符串 / 混型数组', () => {
    assert.equal(validateSettingValue('collapsedGroups', null).ok, true);
    assert.equal(validateSettingValue('collapsedGroups', ['image', 'video']).ok, true);
    assert.equal(validateSettingValue('collapsedGroups', 'image').ok, false);
    assert.equal(validateSettingValue('collapsedGroups', ['image', 1]).ok, false);
  });
  test('navOrder 合法：null 或对象（结构交给 computeNavPlan 净化）；非法：字符串 / 数组', () => {
    assert.equal(validateSettingValue('navOrder', null).ok, true);
    assert.equal(validateSettingValue('navOrder', { groups: ['image'], tools: { image: ['obfuscate'] } }).ok, true);
    assert.equal(validateSettingValue('navOrder', 'image').ok, false);
    assert.equal(validateSettingValue('navOrder', []).ok, false);
  });
  test('theme 合法：system / light / dark；非法：其它', () => {
    assert.equal(validateSettingValue('theme', 'system').ok, true);
    assert.equal(validateSettingValue('theme', 'light').ok, true);
    assert.equal(validateSettingValue('theme', 'dark').ok, true);
    assert.equal(validateSettingValue('theme', 'darkmode').ok, false);
    assert.equal(validateSettingValue('theme', 'DARK').ok, false);
    assert.equal(validateSettingValue('theme', 1).ok, false);
  });
  test('videodlDir 合法：任意字符串（含空串）；非法：非字符串', () => {
    assert.equal(validateSettingValue('videodlDir', '').ok, true);
    assert.equal(validateSettingValue('videodlDir', 'D:\\视频素材').ok, true);
    assert.equal(validateSettingValue('videodlDir', 123).ok, false);
    assert.equal(validateSettingValue('videodlDir', null).ok, false);
  });
  test('videodlAutoCheck 合法：布尔；非法：其它', () => {
    assert.equal(validateSettingValue('videodlAutoCheck', true).ok, true);
    assert.equal(validateSettingValue('videodlAutoCheck', false).ok, true);
    assert.equal(validateSettingValue('videodlAutoCheck', 'on').ok, false);
    assert.equal(validateSettingValue('videodlAutoCheck', 1).ok, false);
  });

  // —— 3) 导入挑选 ——
  test('pickImportableSettings：合法键进 patch、非法键进 skipped、未知键忽略', () => {
    const r = pickImportableSettings({
      blockSize: 32,          // 合法
      theme: 'dark',          // 合法
      jpegQuality: 999,       // 非法
      outputDir: 'D:\\x',     // 合法
      evilKey: '<script>'     // 未知：忽略
    });
    assert.deepEqual(r.applied.sort(), ['blockSize', 'outputDir', 'theme']);
    assert.deepEqual(r.patch, { blockSize: 32, theme: 'dark', outputDir: 'D:\\x' });
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].key, 'jpegQuality');
  });
  test('pickImportableSettings：全部不合法时 applied 为空（上层据此拒绝导入）', () => {
    const r = pickImportableSettings({ blockSize: 99999, theme: 'hacker' });
    assert.equal(r.applied.length, 0);
    assert.equal(r.skipped.length, 2);
  });
  test('pickImportableSettings：非对象输入不抛错、返回空结果', () => {
    for (const v of [null, undefined, 'x', 42, []]) {
      const r = pickImportableSettings(v);
      assert.equal(r.applied.length, 0);
      assert.equal(r.skipped.length, 0);
    }
  });
  test('pickImportableSettings：原型污染键（__proto__ / constructor）不会被挑进 patch', () => {
    const incoming = JSON.parse('{"__proto__": {"evil": 1}, "constructor": {"prototype": {"evil": 1}}, "theme": "light"}');
    const r = pickImportableSettings(incoming);
    assert.deepEqual(r.applied, ['theme']);
    assert.equal(Object.prototype.hasOwnProperty.call(r.patch, '__proto__'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(r.patch, 'constructor'), false);
    assert.equal(({}).evil, undefined); // 原型未被污染
  });

  // —— 4) escapeHtml（设置弹窗的渲染兜底：合法路径也可能含 HTML 字符） ——
  test('escapeHtml：五个敏感字符都转义', () => {
    assert.equal(escapeHtml('<img src=x>'), '&lt;img src=x&gt;');
    assert.equal(escapeHtml('a&b'), 'a&amp;b');
    assert.equal(escapeHtml('"onload"'), '&quot;onload&quot;');
    assert.equal(escapeHtml("it's"), 'it&#39;s');
  });
  test('escapeHtml：转义后的值不会再组成标签', () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const safe = escapeHtml(evil);
    assert.equal(/<img/i.test(safe), false);
    assert.equal(safe.includes('&lt;img'), true);
  });
  test('escapeHtml：非字符串入参按字符串处理（数字等）', () => {
    assert.equal(escapeHtml(32), '32');
    assert.equal(escapeHtml(null), 'null');
  });

  return { pass, fail, total: pass + fail, failures };
}
