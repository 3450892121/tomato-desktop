// A 批媒体工具自检：`electron . --av-test`
// 覆盖两个新工具：视频压缩（video-compress）、音频剪辑（audio-edit）。
// 每个工具各自的自检模块负责「核心逻辑 + 真实 ffmpeg 转码 + 界面走查 + 截图」，
// 本文件只做汇总与落盘，避免把两套夹具逻辑写在一个大文件里。
// 结果写 %TEMP%/tomato-av-test.json，ok:true 为通过。
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const RESULT_FILE = path.join(os.tmpdir(), 'tomato-av-test.json');

function writeResult(payload) {
  try {
    fs.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('[av-test] 结果文件写入失败：', err.message);
  }
  return RESULT_FILE;
}

/**
 * 跑两个工具的自检
 * @param {import('electron').BrowserWindow} win
 */
async function runAvTest(win) {
  const result = { tools: {}, failures: [] };

  const parts = [
    { key: 'video-compress', label: '视频压缩', module: './video-compress-test.js', logic: 'runVideoCompressTest', ui: 'runVideoCompressUiTest' },
    { key: 'audio-edit', label: '音频剪辑', module: './audio-edit-test.js', logic: 'runAudioEditTest', ui: 'runAudioEditUiTest' }
  ];

  for (const p of parts) {
    const entry = { label: p.label };
    try {
      const mod = require(p.module);
      // 先跑核心逻辑 + 真实转码，再跑界面走查；任一环节抛错都记录但不中断另一个工具
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

module.exports = { runAvTest, writeResult, RESULT_FILE };
