# Contributing / 参与贡献

[中文](#中文) · [English](#english) · [Build & test](docs/zh/build.md) · [AGENTS.md](AGENTS.md)

## 中文

### 先读
- [`README.md`](README.md) — 项目定位与下载
- [`docs/zh/build.md`](docs/zh/build.md) — 源码运行、测试、打包
- [`AGENTS.md`](AGENTS.md) — 仓库纪律（工具隔离、加装包、隐私防漏）

### 开发流程
1. Fork 仓库，从 `main` 建分支；
2. `cd app && npm install`；
3. 改代码 / 补测试；新工具按 [`docs/新增工具指南.md`](docs/新增工具指南.md)；
4. 跑 `npm test` + 相关 Electron 自检；
5. 打包前跑全量 29 项：`pwsh -File app/tools/run-all-self-tests.ps1`；
6. 提交信息用 `fix:` / `feat:` / `docs:` / `chore:`；
7. 开 PR，说明改了什么、怎么验证的。

### 不要提交
- `app/addons/`、`app/release/`、`app/userdata/`、`node_modules/`；
- token / 密码 / 密钥 / cookie / 个人路径；
- 测试生成的临时文件与截图（放 `%TEMP%` 或 `artifacts/`，后者不进 git）。

### 新增工具
- 一个工具一个目录 `app/src/tools/<name>/`；
- 工具之间禁止互相 import；共享能力放 `src/shared/`；
- 在 `app/src/shell/registry.js` 注册；
- 在 `app/tools/pack.js` 白名单加文件；
- 补测试与验收口径。

## English

### Read first
- [`README.en.md`](README.en.md) — project overview and downloads
- [`docs/en/build.md`](docs/en/build.md) — run, test, package
- [`AGENTS.md`](AGENTS.md) — repository rules

### Workflow
1. Fork the repo and branch from `main`;
2. `cd app && npm install`;
3. Implement and add tests; for a new tool follow [`docs/新增工具指南.md`](docs/新增工具指南.md) (Chinese);
4. Run `npm test` plus the relevant Electron self-tests;
5. Before packaging, run the full 29-test harness: `pwsh -File app/tools/run-all-self-tests.ps1`;
6. Use `fix:` / `feat:` / `docs:` / `chore:` commit prefixes;
7. Open a PR describing the change and how you verified it.

### Do not commit
- `app/addons/`, `app/release/`, `app/userdata/`, `node_modules/`;
- tokens, passwords, keys, cookies, or personal paths;
- generated temp files/screenshots (use `%TEMP%` or `artifacts/`, which is not tracked).

### New tools
- One folder per tool: `app/src/tools/<name>/`;
- tools must not import each other; shared code goes in `src/shared/`;
- register in `app/src/shell/registry.js`;
- add files to the `app/tools/pack.js` allowlist;
- add tests and acceptance criteria.
