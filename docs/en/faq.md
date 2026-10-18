# FAQ

[Documentation](../README.md) · [Getting started](getting-started.md) · [Agent access](agent.md) · [中文](../zh/faq.md)

## Install / run

**Nothing happens on double-click, or antivirus blocks it.**
Check Windows SmartScreen first: **More info** → **Run anyway**. Some antivirus products flag unsigned portable apps; add the folder to the trust list. Everything except Video Download is offline, so you can verify without network.

**Do I need to install it? How do I uninstall?**
No install. Unzip and run; delete the folder to uninstall. Settings live in `userdata\`; no registry writes.

**Does it support Windows 7 / 32-bit?**
Only Windows 10 / 11 64-bit has been tested.

**Why are there two names?**
The window says "番茄工具箱"; the exe is `番茄图片混淆桌面版.exe`. Same app.

## Usage

**Where are the outputs? Will originals be overwritten?**
Next to the input by default, with suffixes such as `-obfuscated` / `-compressed`. **Originals are not overwritten**; duplicate names get a numeric suffix. You can set an output folder in Settings.

**The deobfuscated image doesn't match.**
Obfuscate and deobfuscate must use the **same mode and key**. `b` (block) mode pads to a multiple of 32; other modes keep the original size.

**Does it need the internet?**
Only Video Download. The other 22 tools work offline.

**It says an add-on is missing.**
The release bundle includes ffmpeg, LibreOffice, Real-ESRGAN, FunASR, OCR, 7-Zip, yt-dlp, and HiBit. If you have a slim distribution without HiBit, see [`加装包说明.txt`](../加装包说明.txt) to restore Software Uninstall.

**How do I move it to another PC?**
Copy the whole folder, or use Settings → Export / Import.

**How do I update?**
Download the new zip, extract to a new folder, copy the old `userdata\` over, then delete the old folder once verified.

## AI / MCP

**DSH does not show Tomato Toolbox tools.**
1. Confirm you double-clicked `一键接入DSH.cmd`;
2. Fully quit and restart DSH;
3. Verify `mcp-tomato-toolbox` in `~/.dsh/profiles/*/cordis.patch.yml`;
4. Check DSH logs for MCP errors.

**Qoder does not show Tomato Toolbox tools.**
1. Confirm you double-clicked `一键接入Qoder.cmd`;
2. Fully quit and reopen Qoder, then **start a new conversation**;
3. Verify `mcpServers.tomato-toolbox` in `~/.qoder-cn/settings.json`;
4. The Qoder tool prefix is `mcp__tomato_toolbox__` (underscore).

**Not sure the setup took effect?**
Double-click `一键体检Agent接入.cmd`. It checks the config and Skill for DSH / Qoder / Trae / WorkBuddy / ZCode, actually starts each MCP server to count tools, and reports healthy / broken / not integrated with the failing step. It never modifies any config.

**Why does it keep returning `NEEDS_APPROVAL`?**
Video Download asks every time by default. Approve in the Video Download page, or enable the session grant.

**The agent says "outside the allowed roots".**
MCP allows home / temp / app by default. Add the folder to `TOMATO_MCP_ALLOWED_ROOTS`, or move the file into an allowed root.

**Can the agent change the video-download approval?**
No. Only the GUI writes it; MCP reads it.

**Does every AI call show a confirmation dialog?**
No. Only Video Download has an approval gate; other tools run immediately. Ask the agent for a plan/preview first; batch rename previews by default.

**Can I make the agent read-only?**
Set `TOMATO_MCP_READONLY=1`.

## Other

**Video Download fails on some sites.**
Site changes can break parsing; use the in-app "Update engine" action, or wait for an engine update.

**AI upscale is unavailable.**
It requires a Vulkan GPU; fall back to normal sharpen/enhance.

**Why can RAR only be extracted?**
RAR is proprietary; free tools cannot create it. The UI marks it "extract only".
