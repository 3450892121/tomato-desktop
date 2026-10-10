## 1. 使用的方案

本仓库**没有引入任何第三方日志框架**（winston、pino、bunyan、log4js、npmlog、consola、signale、debug 等均不在依赖中）。所有日志输出统一使用 Node.js 内置的 `console` API：`console.log`、`console.error`、`console.warn`。测试脚本也直接复用这些 API。

`app/package.json` 的 dependencies 与 devDependencies 中不存在日志类包；grep 仅在少数 videodl 解析器文件中出现 `require('debug')` 等字符串，但实际未作为运行时依赖被使用。

## 2. 关键文件

- `app/main.js` — 主进程唯一集中处理未捕获异常/拒绝的地方，并定义结构化 smoke/self-test 日志前缀
- `app/src/shell/shell.js` — shell 层工具加载失败时的错误日志
- 各工具的 `ui.js`（如 `app/src/tools/*/ui.js`）— 通过 `import { log } from './core'` 调用业务模块暴露的 `log` 方法，最终落到 `console.log`
- `app/tests/*.test.mjs` / `*-test.js` — 测试用例通过 `console.log` 输出结果

## 3. 架构与约定

### 3.1 两层日志模式

- **应用运行期日志**：主进程和 shell 直接使用 `console.error` 输出错误，带 `[main]`、`[shell]` 等方括号前缀标识来源。
- **工具任务日志**：每个工具在 `core` 子模块中暴露一个 `log(result)` 方法（返回字符串），由 `main.js` 中的任务队列消费时拼接为 `${entry.tag} ${entry.log(result)}` 后 `console.log` 到 stdout。这是任务进度/结果的正式输出通道。

### 3.2 结构化输出约定

主进程对自动化场景定义了若干固定前缀，便于外部脚本/CI 解析：

| 前缀 | 用途 | 触发位置 |
|---|---|---|
| `SMOKE_NAV` | 导航检查输出 | `main.js` |
| `SMOKE_UI` | UI 检查输出 | `main.js` |
| `SMOKE_TEST_FAIL` | smoke 测试失败详情 | `main.js` |
| `SMOKE_TEST_OK` | smoke 测试通过摘要 | `main.js` |
| `SELF_TEST` / `SELF_TEST_FAIL` | 自测输出 | `main.js` |
| `MAKE_SAMPLES` / `MAKE_SAMPLES_FAIL` | 样本生成 | `main.js` |
| `VERIFY_SAMPLES` / `VERIFY_SAMPLES_FAIL` | 样本校验 | `main.js` |

这些前缀是硬编码字符串，不是通过配置切换的级别系统。

### 3.3 未捕获异常兜底

`main.js` 中注册了 `process.on('uncaughtException', ...)` 与 `process.on('handledRejection', ...)`，统一用 `console.error('[main] uncaughtException' | 'unhandledRejection', err)` 输出，并在 try/catch 中忽略“无控制台”的情况（绿色版打包后可能没有终端）。

### 3.4 错误输出与用户反馈分离

- 程序内部诊断 → `console.error`（stderr）
- 任务进度/结果 → `console.log`（stdout，供上游脚本解析）
- UI 层的错误信息通过 Electron `dialog.showErrorBox` 弹窗展示给用户，不混入日志流

## 4. 约定与约束

- **不使用第三方日志库**：代码中未发现 `require('winston'|'pino'|'bunyan'|'log4js'|'npmlog'|'consola'|'signale'|'debug')` 的实际导入语句，所有输出走 `console`。
- **结构化前缀必须保留**：`SMOKE_*`、`SELF_TEST*`、`MAKE_SAMPLES*`、`VERIFY_SAMPLES*` 等前缀被 `app/tools/pack.js` 等构建/测试脚本按字面匹配解析，修改前缀会破坏 CI。
- **任务日志接口契约**：每个工具的 `core` 模块需导出 `{ log(result){...} }`，返回值应为可拼接到 `console.log` 的字符串——这是 `main.js` 任务队列消费的隐式契约。
- **未捕获异常统一收敛**：所有未处理的异常与 Promise rejection 都经 `main.js` 的两条 process 事件处理器转发，避免静默丢失。
- **无日志级别系统**：没有 debug/info/warn/error 分级，也没有日志开关或格式化器；调试信息一律以 `console.log` 形式原样输出。
- **终端不可用时容错**：主进程的 uncaughtException/unhandledRejection 处理器包裹 try/catch，因为绿色版通常无控制台，`console.error` 本身也可能抛错。