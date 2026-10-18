# Getting started

[Documentation](../README.md) · [Tools](tools.md) · [FAQ](faq.md) · [中文](../../README.md)

## 1. Download

Open [Releases](https://github.com/3450892121/tomato-desktop/releases/latest) and download:

```text
tomato-desktop-v2.16.0-win64.zip   (~820 MB)
```

Do not download the source archive only; it does not contain the add-ons required for all features.

## 2. Extract

Unzip anywhere — Desktop, Documents, or a USB drive. Non-ASCII paths and spaces are fine. Avoid `C:\Program Files` if possible, because the app writes `userdata` next to itself.

Typical layout:

```text
番茄图片混淆-桌面版-v<version>-win64\
├─ 番茄图片混淆桌面版.exe
├─ 使用说明.txt
├─ 加装包说明.txt
├─ 一键接入DSH.cmd
├─ 一键移除DSH接入.cmd
├─ 一键接入Qoder.cmd
├─ 一键移除Qoder接入.cmd
├─ 一键接入Trae.cmd
├─ 一键移除Trae接入.cmd
├─ 一键接入WorkBuddy.cmd
├─ 一键移除WorkBuddy接入.cmd
├─ 一键接入ZCode.cmd
├─ 一键移除ZCode接入.cmd
├─ 一键体检Agent接入.cmd
├─ Agent接入说明.md
├─ skills\
├─ addons\
└─ userdata\
```

## 3. Run

Double-click `番茄图片混淆桌面版.exe`.

On first launch:

- **Windows SmartScreen**: click **More info** → **Run anyway**. The app is unsigned.
- **Antivirus false positive**: trust the folder. Everything except Video Download is offline, so you can verify without network.

Settings and caches live in `userdata\`; no registry, no system-wide install. Delete the folder to uninstall.

## 4. First steps

1. Click **Image Obfuscate** on the left.
2. Drag an image in, or click **Add images**.
3. Keep the default mode and click **Obfuscate**.
4. Click **Save**.

To restore, click **Deobfuscate** with the same mode and key.

Other good first tasks: Image Compress / Convert, File-in-Image, PDF ↔ images, Compress / Extract.

The package includes a detailed Chinese manual: [`使用说明.txt`](../使用说明.txt). The in-app **Help** button opens the same content.

## 5. Agent access (optional)

DSH users:

1. Double-click `一键接入DSH.cmd`.
2. Fully quit DSH (not just the window) and reopen it.
3. Ask: "Use Tomato Toolbox to compress the images in this folder to under 500 KB."

Qoder users:

1. **Fully quit Qoder first.**
2. Double-click `一键接入Qoder.cmd`.
3. Open Qoder, **start a new conversation**, and ask the same.

No JSON editing and no Node.js installation required. To remove them, double-click `一键移除DSH接入.cmd` / `一键移除Qoder接入.cmd`.

Other clients: see [Agent access](agent.md).

## 6. Move to another PC

- Copy the whole folder; or
- Use **Settings → Export / Import**;
- `userdata\settings.json` can be copied manually, but avoid editing it by hand.

## 7. Update

1. Download the new zip;
2. Extract it into a new empty folder;
3. Copy the old `userdata\` into the new folder (or import settings);
4. Once verified, delete the old folder.

Do not overwrite a running installation; quit the app first.
