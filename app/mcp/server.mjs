#!/usr/bin/env node
// 番茄工具箱 · MCP server（stdio 传输）
//
// 目标：让支持 MCP 的 agent（DSH / Claude Desktop / Qoder / Trae 等）直接调用
// 本软件的本地能力，而不需要开 GUI。第一批只注册纯 Node 工具：
//   图片混淆、文件藏图、压缩/解压、PDF 组装、批量重命名。
//
// 协议：JSON-RPC 2.0，一行一条消息（MCP stdio 传输）。
// 重要：stdout 只能输出协议消息；所有日志走 stderr，否则客户端会解析失败。
import readline from 'node:readline';
import { tools, findTool, publicToolList } from './tools/index.mjs';
import { jsonResult, errorResult } from './lib/result.mjs';

const SERVER_INFO = { name: 'tomato-toolbox', version: '2.13.0' };
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(...args) {
  console.error('[tomato-mcp]', ...args);
}

function rpcError(id, code, message) {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

async function handleRequest(msg) {
  const { id, method, params } = msg || {};

  if (method === 'initialize') {
    const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : '2024-11-05';
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
    const tool = findTool(name);
    if (!tool) {
      send({ jsonrpc: '2.0', id, result: errorResult(`未知工具：${name}`) });
      return;
    }
    try {
      const value = await tool.handler(args);
      // 允许工具自己返回完整 MCP 结果（带 content），否则统一包成 JSON
      const result = value && Array.isArray(value.content) ? value : jsonResult(value);
      send({ jsonrpc: '2.0', id, result });
    } catch (err) {
      const message = String((err && err.message) || err || '工具执行失败');
      log(`tool ${name} failed:`, message);
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
