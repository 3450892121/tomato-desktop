# 跨工具任务队列 + 任务中心

## 要解决的两个问题
1. 各工具的批量任务原先由工具页自己 `for` 循环执行，用户切走工具页后就看不到整体进度，也不知道还有几个任务在跑。
2. 工具页有**保活上限（LRU 回收）**：被回收时会调 `unmount()`，而旧实现的 `unmount()` 会取消在跑的任务——「切工具切多了，后台任务连坐被杀」。

## 硬契约（框架层必须遵守）
**入队后的任务归属队列，不归属工具页。**
- 工具 `unmount()`（LRU 回收 / 切换）**只退订 UI 订阅**（解绑事件、取消进度订阅），**不得取消队列中的任务**；任务照跑完，产物照常落盘。
- 任务中心的打开/关闭同样不影响任务执行（它只做展示与操作转发，不持有任务状态）。
- 运行态**不持久化**：重启后未完成的一律丢弃；只在内存里保留「最近完成记录」（最多 50 条）。
- **失败不自动重试**（可能覆盖产物），只提供用户显式 `retry`。

## 通道与并发
| 通道 | 默认并发 | 用于 |
|---|---|---|
| `cpu` | 1 | ffmpeg / PDF / OCR 等吃满 CPU 的任务（串行最稳） |
| `io` | 2 | canvas 图片类（解码/编码/落盘） |

未知通道名一律归 `cpu`（保守串行，不会因写错通道名把 CPU 打满）。通道之间互不挤占额度。

## 任务数据结构
```
Task = {
  id, toolId, toolName, label,
  lane: 'cpu' | 'io',
  status: 'queued'|'running'|'done'|'failed'|'canceled',
  progress: 0..100, stepText,
  input: { paths: [] }, output: { paths: [], dir },
  error, retryCount, cancelRequested,
  createdAt, startedAt, endedAt
}
```

## API（`src/shared/taskqueue.js`，纯逻辑、无 DOM、可被 Node 直接单测）
- `createQueue({ concurrency?, onChange?, onTaskDone? })`
- `enqueue({ toolId, toolName, label, lane, run, onCancel, inputPaths?, outputDir? })` → `taskId`
  - `run(ctx)`：`ctx = { report({percent,text}), isCancelled() }`；返回 `{ok, outputPaths?, outputDir?, error?, canceled?}`
- `runBatch({ toolId, toolName, lane, jobs })` → 全部终态后的任务数组（与 jobs 同序）
- `cancel(id)` / `cancelAll()` / `list()` / `get(id)` / `summary()` / `clearFinished()` / `retry(id)` / `recentFinished(limit)` / `waitFor(id)`
- 取消语义：`queued` 直接标记 `canceled`；`running` 置 `cancelRequested` 并调 `onCancel()`（工具在里面杀 ffmpeg 进程 / 置自己的取消标志）。已请求取消时 `run` 抛错也算取消（进程被杀属正常路径）。
- `summary().percent`：按任务条数加权——终态记 100（失败/取消也算「已结束」）、运行中记其进度、排队记 0。

## 界面：任务中心（`src/shell/taskcenter.js`）
- 入口：顶栏「任务」按钮 + 未完成数量徽标（`running + queued`，为 0 时不显示）。
- 面板：右侧侧滑抽屉（与既有视觉一致，只用 `theme.css` 变量）。内容：汇总（N 个进行中 / M 个排队 / 完成 X / 失败 Y）+ 总进度条 + 「进行中 / 排队」列表 + 「最近完成」列表；操作：单个取消、单个重试（失败/取消项）、全部取消、清空已完成。
- 空态：没有任务时给友好提示。面板关闭时只标记「脏」，打开时再渲染一次（省开销）。
- 由 shell 持有（`shell.js` 创建队列实例与面板），并经 `ctx.tasks` 暴露给工具。

## 工具接入约定
- 接入 = 把工具 `run()` 里的串行 `for` 循环换成「入队 + 单文件执行」，仍 `await` 全部结束以保留原有「跑完汇总 + 按钮恢复」的界面行为。
- 进度：ffmpeg 类工具用模块级 `Map<jobId → {report, index, total, ...}>` 把主进程推来的进度映射到对应任务的 `report()`；工具页被回收再挂载也不丢。
- 一个「整体操作」（拼接、批量重命名）算**一个**任务；逐文件处理的算 N 个任务。
- 工具自己的「取消」按钮改成 `ctx.tasks.cancel(taskId)`；`unmount()` 里删掉取消任务的逻辑。

### 已接入（14）
- 原生接入（8）：`video-compress`、`audio-edit`、`pdf-edit`、`ocr`、`batch-rename`、`watermark`、`stitch`、`grid-slice`
- 小改接入（6）：`audio-convert`、`compress`、`img-convert`、`video-convert`、`sticker`、`enhance`

### 明确不接入（保持原样）
| 工具 | 原因 |
|---|---|
| `obfuscate`（图片混淆） | 单图同步像素重排、毫秒级完成，接入收益低；且其批量流程与工具内状态耦合紧（当前图/缩略图/还原），改造风险大于收益。**行为说明：它的批量任务不出现在任务中心，但工具本身照常可用。** |
| `transcribe`（语音转文字） | 已有自己的完整进度链路（分段进度 + 取消 + 视频提取音轨），且是单文件流程，重复接入易与既有取消逻辑打架。**行为说明：任务不出现在任务中心，工具照常可用。** |
| `pdf-convert`（PDF 转格式） | busy 状态机复杂（LibreOffice 转换 + 内置降级渲染 + 多方向流程），风险高。**行为说明：任务不出现在任务中心，工具照常可用。** |

> 未接入工具的任务只是不出现在任务中心；它们仍按原来的方式运行，功能与输出不变。

## 测试
- 纯逻辑单测：`app/tests/taskqueue-test.js`（`runQueueUnitTests()`，13 项：并发上限、通道隔离、进度聚合、取消 queued/running、失败与 retry、最近完成、runBatch、waitFor、通道归一）。入口 `app/tests/taskqueue.test.mjs`，已挂进 `npm test`（`node tests/engine.test.mjs && node tests/taskqueue.test.mjs`）。
- 界面自动测试：`app/tests/queue-ui-test.js`（`electron . --queue-ui-test`）——顶栏入口与徽标、任务中心开合与空态、真实转码批量、**核心断言：切走工具页并触发 LRU 回收后任务照跑完、产物存在且可被 ffmpeg 完整解码**、任务中心能看到已完成/已取消、能取消排队任务、能清空已完成；截图 `shot-queue-*.png`，结果写 `%TEMP%/tomato-queue-ui-test.json`。

## 主进程（main.js）接线（已由维护者完成）
- `const queueUiTest = process.argv.includes('--queue-ui-test');`
- 已加入 `app.disableHardwareAcceleration()` 与 `testMode()` 的判断。
- 已加 `did-finish-load` → `require('./tests/queue-ui-test.js').runQueueUiTest(mainWindow)` → 打印 `QUEUE_UI_TEST` → `app.quit()`。
- `pack.js` 步骤 4 已同步拷贝 `queue-ui-test.js`。

任务中心的「最近完成记录」目前**只保留在内存**（上限 50 条）：没有现成的 `userdata/tasks.json` 读写 IPC，按「不擅自扩主进程」的约定不做持久化。重启后记录清空属预期行为（运行中的任务本来也无法续跑——ffmpeg 临时文件与 canvas 内存图都不可安全恢复）。