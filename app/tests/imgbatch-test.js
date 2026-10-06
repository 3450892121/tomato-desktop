// B 批图片工具自检：`electron . --imgbatch-test`
// 覆盖四个新工具：批量重命名（batch-rename）、加水印（watermark）、长图拼接（stitch）、九宫格切图（grid-slice）。
// 每个工具各自的自检模块负责「纯逻辑断言 + 真实处理 + 界面走查 + 截图」，本文件只做汇总与落盘。
// 结果写 %TEMP%/tomato-imgbatch-test.json，ok:true 为通过。
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const RESULT_FILE = path.join(os.tmpdir(), 'tomato-imgbatch-test.json');

function writeResult(payload) {
  try {
    fs.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('[imgbatch-test] 结果文件写入失败：', err.message);
  }
  return RESULT_FILE;
}

/**
 * 跑四个工具的自检
 * @param {import('electron').BrowserWindow} win
 */
async function runImgbatchTest(win) {
  const result = { tools: {}, failures: [] };

  const parts = [
    { key: 'batch-rename', label: '批量重命名', module: './batch-rename-test.js', logic: 'runBatchRenameTest', ui: 'runBatchRenameUiTest' },
    { key: 'watermark', label: '加水印', module: './watermark-test.js', logic: 'runWatermarkTest', ui: 'runWatermarkUiTest' },
    { key: 'stitch', label: '长图拼接', module: './stitch-test.js', logic: 'runStitchTest', ui: 'runStitchUiTest' },
    { key: 'grid-slice', label: '九宫格切图', module: './grid-slice-test.js', logic: 'runGridSliceTest', ui: 'runGridSliceUiTest' }
  ];

  for (const p of parts) {
    const entry = { label: p.label };
    try {
      const mod = require(p.module);
      // 先跑纯逻辑 + 真实处理，再跑界面走查；任一环节抛错都记录，但不中断后面的工具
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

module.exports = { runImgbatchTest, writeResult, RESULT_FILE };