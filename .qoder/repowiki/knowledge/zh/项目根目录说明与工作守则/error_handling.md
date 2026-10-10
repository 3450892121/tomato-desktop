## 1. 整体方式

仓库是纯前端桌面应用（Electron 渲染进程 + Node 预加载），没有后端中间件、也没有自定义异常类型体系。错误处理的总体策略是：**在共享能力层把底层库抛出的原生错误捕获并改写为面向用户的中文 `Error`，再沿调用栈向 UI 层传播；UI 层的 `.catch()` / `try...catch` 只负责展示结果。**

- 未定义全局 error middleware；错误通过 Promise rejection 和 `throw new Error(...)` 冒泡。
- 不滥用 `panic/recover`（JS 无 panic）；只在极小范围使用空 `catch {}` 忽略可预期失败（例如 shell.js 中探测设置写入失败 `.catch(() => {})`、enhance/ui.js 中 GPU 探测失败）。
- 所有用户可见的错误消息均为简体中文，避免直接暴露技术细节（如堆栈、内部文件名）。

## 2. 关键文件与位置

| 文件 | 职责 |
|---|---|
| `app/src/shared/pdfops.js` | PDF 打开/渲染的共享入口，把 pdfjs 的 `PasswordException`、`InvalidPDFException` 映射为用户可读错误 |
| `app/src/shared/imageio.js` | 图片解码/编码共享入口，统一抛出“格式不支持或文件损坏”“超过 4000 万像素上限”等错误 |
| `app/src/shared/heic.js` | HEIC 解码失败时返回友好错误 |
| `app/src/tools/videodl/core/errors.mjs` | 站点下载错误 → 中文提示的集中映射（DRM、403/404/429、超时、地区限制、登录要求等） |
| `app/src/tools/ocr/core/convert.js` | OCR 子任务错误文本的本地化包装（`friendlyOcrMessage`） |
| 各工具 `ui.js` | 实际捕获并展示错误的 UI 层 |

## 3. 架构与约定

### 3.1 分层错误转换

共享层（`shared/`）作为最底层，向上抛出语义化的中文 `Error`，工具层不再重复翻译：

```js
// pdfops.js
if (err && err.name === 'PasswordException') throw new Error('这个 PDF 有打开密码，需要先输入密码。');
if (err && err.name === 'InvalidPDFException') throw new Error('文件不是有效的 PDF（或已损坏）。');
throw new Error(`打开 PDF 失败：${(err && err.message) || err}`);
```

```js
// imageio.js
throw new Error('解码图片失败，可能是格式不支持或文件损坏。');
throw new Error(`图片过大（${width}×${height}，超过 ${MAX_PIXELS / 1_000_000} 万像素上限），已停止处理以免内存不足。`);
```

视频下载器则维护一个独立的规则表 `describeDownloadError(message)`，根据底层 yt-dlp 错误消息正则匹配给出对应中文文案（DRM、地理限制、403/404/429、TLS 握手失败等）。

### 3.2 工具层 UI 仅消费错误

工具 `index.js` → `core/*` → `shared/*` 的错误流单向向上；每个工具的 `ui.js` 统一以 `try/catch` 包裹异步流程，并把 `err.message` 交给界面组件显示。常见模式：

```js
try {
  // ... 调用 core 逻辑
} catch (err) {
  // 展示给用户
}
```

部分 UI 还会对网络请求单独做 `!res.ok` 检查后主动 `throw new Error((res && res.message) || 'ffmpeg 解码失败')`，使 HTTP 状态码也转为中文。

### 3.3 可取消与进度回调

共享层 API 通过 `onProgress`、`shouldCancel` 回调让上层在长任务中主动中止，而不是依赖错误传播。例如 `compressPdf` 会在每页渲染前检查 `shouldCancel()`，返回 `{ cancelled: true }` 而非抛错。

### 3.4 资源释放与静默兜底

PDF 文档释放 `releasePdfDoc` 用空 `catch` 容忍已经销毁的对象；GPU 能力探测失败 `.catch(() => {})` 按“未检测到”降级处理。这些是刻意设计的静默失败路径。

## 4. 观察到的约定与约束

- **用户可见错误必须为中文**：所有 `throw new Error(...)` 的消息都是自然语言中文，不含内部实现细节。
- **底层库异常在 shared 层被捕获并改写**：pdfjs 的 `PasswordException` / `InvalidPDFException`、HEIC 解码失败、图片尺寸超限均在 `shared/` 内转换，工具层看不到原始异常名。
- **HTTP 响应非成功时显式抛错**：多处 `if (!res || !res.ok) throw new Error((res && res.message) || '…')`，确保网络错误能带上平台返回信息。
- **OCR 子任务错误经 `friendlyOcrMessage` 二次包装**：`tools/ocr/ui.js` 在 `core/convert.js` 的错误基础上再做一次用户态转换。
- **视频下载错误集中于 `errors.mjs`**：`describeDownloadError` 是唯一的站点错误→中文映射点，其他模块通过 import 引用，避免散落正则。
- **不定义自定义 Error 子类**：仓库未出现 `class XxxError extends Error` 或枚举错误码；错误分类靠消息内容和调用上下文区分。
- **不存在全局错误中间件**：错误通过 Promise rejection 与 `throw` 冒泡到 UI 层，由各个 `ui.js` 自行呈现。
- **可预期的轻微失败会吞掉**：空 `catch {}` 出现在 GPU 探测、设置持久化等场景，用于优雅降级。

这些是代码实际呈现的模式；仓库中没有发现成文的强制规范文档规定这些行为，因此上述“约定”描述的是观察到的实现事实，而非被 lint/CI 强执行的规则。