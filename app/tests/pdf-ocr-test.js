// C 批工具自检：`electron . --pdf-ocr-test`
// 覆盖两个新工具：「PDF 编辑整理」（pdf-edit）与「文字识别」（ocr）。
// 各自的自检模块负责「纯逻辑 + 真实处理与读回校验 + 界面走查 + 截图」，本文件只做汇总与落盘。
// 结果写 %TEMP%/tomato-pdf-ocr-test.json，ok:true 为通过。
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const RESULT_FILE = path.join(os.tmpdir(), 'tomato-pdf-ocr-test.json');

function writeResult(payload) {
  try {
    fs.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('[pdf-ocr-test] 结果文件写入失败：', err.message);
  }
  return RESULT_FILE;
}

/**
 * 跑两个工具的自检
 * @param {import('electron').BrowserWindow} win
 */
async function runPdfOcrTest(win) {
  const result = { tools: {}, failures: [] };

  const parts = [
    { key: 'pdf-edit', label: 'PDF 编辑整理', module: './pdf-edit-test.js', logic: 'runPdfEditTest', ui: 'runPdfEditUiTest' },
    { key: 'ocr', label: '文字识别', module: './ocr-test.js', logic: 'runOcrTest', ui: 'runOcrUiTest' }
  ];

  for (const p of parts) {
    const entry = { label: p.label };
    try {
      const mod = require(p.module);
      entry.logic = await mod[p.logic](win);
      if (!entry.logic || entry.logic.ok !== true) {
        result.failures.push(`${p.label}：核心自检未通过`);
      }
      entry.ui = await mod[p.ui](win);
      if (!entry.ui || entry.ui.pass !== true) {
        result.failures.push(`${p.label}：界面走查未通过`);
      }
    } catch (err) {
      entry.error = `${err.message}\n${err.stack}`;
      result.failures.push(`${p.label}：${err.message}`);
    }
    result.tools[p.key] = entry;
  }

  result.ok = result.failures.length === 0;
  writeResult({ ok: result.ok, at: new Date().toISOString(), result });
  return result;
}

module.exports = { runPdfOcrTest, writeResult, RESULT_FILE };