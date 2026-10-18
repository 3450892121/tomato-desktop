# Build & test

[Documentation](../README.md) · [Getting started](getting-started.md) · [中文](../zh/build.md) · [AGENTS.md](../../AGENTS.md)

## 1. Requirements

- Windows 10 / 11 64-bit;
- Node.js 22+ (npm included);
- ~3 GB free space (dependencies + Electron + add-ons).

```bash
cd app
npm install
npm start
```

Slow network in mainland China:

```bash
npm install --registry=https://registry.npmmirror.com
# PowerShell
$env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"
```

## 2. Unit tests

```bash
cd app
npm test
```

Includes the existing logic tests plus 21 MCP tests; no network or add-ons required.

Single file:

```bash
node tests/xxx.test.mjs
```

## 3. Self-tests and UI automation

```bash
cd app
.\node_modules\electron\dist\electron.exe . --smoke-test
.\node_modules\electron\dist\electron.exe . --ui-test
.\node_modules\electron\dist\electron.exe . --pdf-test
.\node_modules\electron\dist\electron.exe . --media-test
.\node_modules\electron\dist\electron.exe . --archive-test
```

Results are written to `%TEMP%\tomato-*.json`; check `pass:true` / `ok:true`. Screenshots go to `%TEMP%\tomato-uitest`.

### Full 29-test harness

```powershell
cd app
pwsh -File tools/run-all-self-tests.ps1            # source tree
pwsh -File tools/run-all-self-tests.ps1 -Packaged  # packaged build
```

Result: `%TEMP%\tomato-run-all.json`; logs: `%TEMP%\tomato-run-*.log`.

### Packaged-build expectations

- `--imghide-test`: `ok:true / verified:false`; `skipped` includes the official interop oracle (not shipped);
- `--videodl-test`: `ok:true / verified:false`; `skipped` contains only the online engine-update test (the packaged run sets `VIDEODL_TEST_SKIP_UPDATE=1`).

The source-tree deliverable requires `verified:true` for both.

### Before `--ui-test`

Clear `app/userdata/settings.json`; the test requires the default navigation profile. A custom `navOrder` makes `navSort.resetHiddenInitially` fail.

## 4. MCP tests

```bash
cd app
node tests/mcp.test.mjs          # 21 tests
node tests/pack-mcp-smoke.mjs    # 9 tests against the release build
```

Coverage: path allowlist, audit log, read-only mode, no-overwrite, real ffmpeg / OCR / ASR / LibreOffice / pdfjs / Canvas, and an authorized video download.

## 5. Packaging

```bash
cd app
npm run pack
```

Output:

```text
app/release/番茄图片混淆-桌面版-v<version>-win64/
app/release/番茄图片混淆-桌面版-v<version>-win64.zip
```

`pack.js` copies the Electron runtime, app sources, MCP server, pdfjs legacy, and add-ons; slims the build; writes the exe icon/version; syncs the desktop shortcut; migrates the previous `settings.json`; and deletes older release folders.

Read the comments at the top of `app/tools/pack.js` before changing packaging. New files must be added to its per-file allowlist.

## 6. Add-ons

`app/addons/` is not in the repository and is ~1.5 GB:

```text
addons/
├─ libreoffice/
├─ ffmpeg/
├─ realesrgan/
├─ asr/
├─ ocr/
├─ 7zip/
├─ ytdlp/
└─ hibit/
```

Placement, versions, and fallback behavior: [`docs/加装包说明.txt`](../加装包说明.txt).
Licenses and distribution obligations: [`THIRD-PARTY-NOTICES.md`](../../THIRD-PARTY-NOTICES.md).

## 7. Adding a tool

1. Copy `app/src/tools/_template/` to `app/src/tools/<name>/`;
2. Set `id` / `name` / `icon` / `group` / `order`;
3. Add the import and entry in `app/src/shell/registry.js`;
4. Tools must not import each other; shared code goes in `src/shared/`;
5. Styles stay in the tool's `styles.css`; use variables from `shell/theme.css`;
6. Add new files and tests to the `app/tools/pack.js` allowlist.

See [`新增工具指南.md`](../新增工具指南.md) (Chinese).

## 8. Commit and release

- bug fix → `z+1`; feature → `y+1`; breaking change → `x+1`;
- one commit per change; prefix with `fix:` / `feat:` / `docs:` / `chore:`;
- before delivery: full 29 source tests + 29 packaged tests + `npm test` + `pack-mcp-smoke`;
- tag the release; sync the desktop shortcut;
- keep only the latest release folder; history lives in git tags.

See [`AGENTS.md`](../../AGENTS.md) for the full repository rules.
