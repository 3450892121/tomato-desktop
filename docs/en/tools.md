# Tools

[Documentation](../README.md) · [Getting started](getting-started.md) · [FAQ](faq.md) · [中文](../zh/tools.md)

**24 tools** in six groups. Click a group header to expand/collapse; long-press to reorder.

## Image

| Tool | What it does | Input → output | Notes |
|---|---|---|---|
| Image Obfuscate | Scramble an image, or restore it | Image → image | Six modes; mode + key must match; interoperable with the Android app |
| Image Compress | Quality / size / target-size compression | JPG/PNG/WebP/HEIC etc. → JPG/PNG/WebP | Target size is best-effort and reported honestly |
| Image Enhance | Sharpen / enhance / AI upscale | Image → image | AI upscale needs a Vulkan GPU; Real-ESRGAN bundled |
| Image Convert | Common format conversion | PNG/JPG/WebP/BMP/ICO/TIFF/GIF/AVIF, plus HEIC and legacy inputs | Unsupported inputs produce a clear error |
| Batch Rename | Sequence / replace / affix / date rules | File list → new names | Preview by default; conflicts can skip or auto-number; MCP refuses overwrite |
| Watermark | Text / image watermark | Image → image | Position, opacity, tiling |
| Stitch | Join images vertically / horizontally | Image list → image | Widths aligned |
| Grid Slice | Split into a grid (default 3×3) | Image → multiple images | Social-media friendly |
| File-in-Image | Hide any file inside an image, or extract it | File + cover → image; image → file | Two containers; PRO mode supports a password; interoperable with "图夹"-style sites/apps |

## Video

| Tool | What it does | Input → output | Notes |
|---|---|---|---|
| Video Download | Download from a URL | URL → video | **Only online tool**; Douyin / Xiaohongshu / Bilibili / YouTube / CCTV / direct links; engine updatable; AI calls need GUI approval |
| Video Player | Play video inside the app | Video → playback | MKV/FLV/TS remuxed losslessly; AVI/WMV etc. converted to a temporary copy |
| Video Convert | MP4/WebM/MKV/MOV/AVI | Video → video | Cancellable, progress shown |
| Video Compress | Quality or target-size compression | Video → video | Two-pass for target size; honest if unreachable |
| GIF ↔ Video | GIF/WebP/APNG ↔ video | Animated image/video → video/animated image | Chat-sticker preset; auto downscale for target size |

## Audio

| Tool | What it does | Input → output | Notes |
|---|---|---|---|
| Audio Convert | 21 output formats; extract audio from video | Audio/video → audio | MP3/AAC/FLAC/WAV/OGG etc. |
| Audio Edit | Waveform trim / concat / fade / normalize | Audio → audio | Preview; never overwrites the original |
| Speech-to-Text | Audio/video → text or subtitles | Audio/video → .txt / .srt | Offline CPU; FunASR bundled; Chinese/English/Japanese/Korean/Cantonese |

## Document

| Tool | What it does | Input → output | Notes |
|---|---|---|---|
| PDF Convert | PDF ↔ images, images → PDF, merge/split/extract, Office → PDF | PDF/image/Office → PDF/image | Built-in fallback for Word/Excel → PDF; LibreOffice for high fidelity |
| Document Convert | Legacy Word/Excel/PPT/RTF → modern formats | doc/xls/ppt/pps/rtf → docx/xlsx/pptx/PDF | Handles Excel 2003 XML "fake .xls" |
| PDF Edit | Compress / watermark / page numbers / rotate / reorder / encrypt / decrypt | PDF → PDF | All operations verified by read-back |
| OCR | Images/scans → searchable PDF / text / Word | Image/PDF → PDF/TXT/DOCX | PP-OCRv5; offline; searchable PDF supports Ctrl+F |

## Archive

| Tool | What it does | Input → output | Notes |
|---|---|---|---|
| Compress / Extract | ZIP/7Z/TAR/GZIP etc.; RAR extract-only | Files/folders ↔ archive | 13 formats round-trip; AES-256; volumes; list without extracting; zip-slip protection |

## System

| Tool | What it does | Input → output | Notes |
|---|---|---|---|
| Software Uninstall | Launch the bundled HiBit uninstaller | Select app → uninstall | Requires UAC admin; never silently elevates; HiBit is bundled in this release, but slim distributions may omit it |

## Relation to MCP

- MCP exposes **21 GUI tools** through **41 tool endpoints**;
- **Video Player and Software Uninstall are not exposed**;
- Video Download requires GUI approval; other tools execute immediately with no confirmation dialog;
- Full parameter reference: [`app/mcp/README.md`](../../app/mcp/README.md) and [Agent access](agent.md).

> Detailed per-tool instructions (Chinese): [`使用说明.txt`](../使用说明.txt). Acceptance criteria: [`spec/acceptance.md`](../../spec/acceptance.md).
