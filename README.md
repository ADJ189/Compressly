<div align="center">

<img src="public/favicon.svg" width="64" alt="CompressZ logo" />

# CompressZ

**Private, browser-native file compression and OCR.**  
Nothing ever leaves your device.

[![Deploy](https://img.shields.io/badge/Cloudflare_Pages-deployed-F38020?logo=cloudflare&logoColor=white)](https://compressz.pages.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)

</div>

---

## Overview

CompressZ compresses images, PDFs, video, audio, and GIFs — and runs OCR on scanned PDFs — entirely inside your browser. No backend, no uploads, no tracking. Every byte stays on your device.

Processing uses WebAssembly (FFmpeg.wasm), the Canvas API, WebCodecs, and two neural OCR engines (Tesseract.js and PaddleOCR) loaded from CDN on first use and cached offline thereafter.

---

## Features

| Tool | Formats | Engine |
|------|---------|--------|
| **Images** | JPEG · PNG · WebP · AVIF · HEIC · BMP · TIFF | OffscreenCanvas (GPU) |
| **PDF Compress** | PDF | PDF.js 4.4 + pdf-lib 1.17 — structural image resampling |
| **Video** | MP4 · WebM · MOV · AVI · MKV | FFmpeg.wasm → WebCodecs → MediaRecorder |
| **Audio** | MP3 · AAC · OGG · Opus · FLAC · WAV | FFmpeg.wasm |
| **GIF** | GIF → optimised GIF or WebM VP9 | FFmpeg.wasm (two-pass palettegen) |
| **SVG** | SVG | Pure TypeScript, zero dependencies |
| **PDF OCR** | Scanned PDF → searchable PDF + TXT | Tesseract.js 5 + PaddleOCR PP-OCRv3 |

---

## OCR Engines

CompressZ ships two independent OCR engines selectable per job, plus an **Auto** mode that analyses each document and picks the best one automatically.

### Tesseract.js 5

- **Technology:** LSTM neural model compiled to SIMD-accelerated WebAssembly
- **Model size:** ~10 MB (cached by browser after first use)
- **Languages:** 100+ including all Latin-script languages, Cyrillic, Arabic, Hebrew, Thai, Vietnamese
- **Best for:** Clean scans, typeset documents, single-column layouts, 300 DPI+ images
- **Accuracy:** >95% on clean 300 DPI scans of typeset text
- **Runs offline:** Yes, fully after first load

### PaddleOCR PP-OCRv3

- **Technology:** Baidu's three-stage pipeline running via WebGL / paddle.js
  1. **PP-OCRv3 text detector** — finds text regions at any angle
  2. **MobileNetV3 direction classifier** — corrects rotated/flipped text
  3. **CRNN recogniser** — character recognition (separate EN and CJK models)
- **Model size:** ~25 MB (cached by browser after first use)
- **Languages:** English, Chinese (Simplified + Traditional), Japanese, Korean, Arabic, Hindi
- **Best for:** Multi-column layouts, tables, forms, rotated/skewed text, handwriting, CJK scripts, low-quality scans
- **Accuracy:** State-of-the-art on complex document layouts
- **Runs offline:** Yes, fully after first load

### Auto Mode

Auto mode renders the first page at a small resolution and measures its dark-pixel density as a proxy for layout complexity. Documents with sparse text (simple layout) are routed to Tesseract; dense/complex documents are routed to PaddleOCR. Language selection also influences the choice — CJK/Arabic/Hindi always uses PaddleOCR.

### Output

- **Searchable PDF** — invisible text layer embedded over the original pages (or a new image-based PDF)
- **Plain text file** (optional) — full extracted text with page separators
- Words below 30% confidence are excluded from the text layer to reduce noise

---

## PDF Compression

Two strategies run in sequence:

**Strategy A — Structural** (default for Low and Recommended presets)  
Iterates the PDF's XObject resource dictionary, finds embedded images, decodes them, downscales to the target DPI via OffscreenCanvas, re-encodes as JPEG, and splices back in-place. Text, fonts, and vector graphics are **never touched** — no rasterisation artifacts.

**Strategy B — Canvas re-render** (Extreme preset, or fallback for encrypted/corrupt PDFs)  
PDF.js renders each page to an OffscreenCanvas with `colorSpace: 'srgb'` and `intent: 'print'`, then pdf-lib embeds the resulting JPEG. Fixes all stitching/color-line artifacts that plagued earlier canvas-based approaches.

| Preset | DPI | JPEG Quality | Strategy |
|--------|-----|-------------|----------|
| Low | 220 | 0.85 | Structural |
| Recommended | 150 | 0.72 | Structural |
| Extreme | 96 | 0.45 | Canvas (flattens everything) |

---

## Architecture

```
compressz/
├── public/
│   ├── _headers          # COOP/COEP → SharedArrayBuffer (FFmpeg MT)
│   ├── _redirects        # SPA fallback (/* → /index.html)
│   ├── favicon.svg
│   ├── robots.txt
│   └── sitemap.xml
├── src/
│   ├── lib/
│   │   ├── types.ts          # Shared types, helpers
│   │   ├── compress.ts       # Central dispatcher
│   │   ├── compressImage.ts  # OffscreenCanvas + binary search
│   │   ├── compressPdf.ts    # Structural + canvas strategies
│   │   ├── compressVideo.ts  # FFmpeg.wasm → WebCodecs → MediaRecorder
│   │   ├── compressAudio.ts  # FFmpeg.wasm (6 formats)
│   │   ├── compressGif.ts    # FFmpeg palettegen + paletteuse
│   │   ├── optimizeSvg.ts    # Pure TS SVG optimiser
│   │   └── ffmpeg.ts         # FFmpeg singleton loader
│   ├── pages/
│   │   ├── images.ts
│   │   ├── pdf.ts
│   │   ├── video.ts
│   │   ├── audio.ts
│   │   ├── gif.ts
│   │   └── ocr.ts            # Tesseract.js + PaddleOCR + searchable PDF builder
│   ├── components.ts     # DropZone + FileCard DOM builders
│   ├── router.ts         # History API SPA router
│   ├── toast.ts          # Toast notifications
│   ├── style.css         # Design tokens + all component styles
│   └── main.ts           # Entry — wires router, theme, nav
├── index.html            # App shell + all <template> page content
├── wrangler.json         # Cloudflare Pages config
├── vite.config.ts        # Vite 6 — esnext, COOP/COEP dev headers
├── tsconfig.json
└── package.json
```

No framework. No Svelte, React, or Vue. Pure TypeScript DOM manipulation with typed components throughout.

---

## Local Development

```bash
npm install
npm run dev        # http://localhost:5173
```

The Vite dev server sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` automatically, enabling SharedArrayBuffer for multithreaded FFmpeg.

```bash
npm run build      # production build → dist/
npm run preview    # serve the build locally
npm run typecheck  # TypeScript check (no emit)
```

---

## Deployment

### Cloudflare Pages (recommended)

1. Push this repo to GitHub
2. **Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git**
3. Select your repo, then set:

   | Setting | Value |
   |---------|-------|
   | Framework preset | Vite |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | Environment variable | `NODE_VERSION` = `20` |

4. Click **Save and Deploy**

The `wrangler.json` and `public/_headers` are picked up automatically. Every subsequent push to `main` redeploys.

### GitHub Actions (auto-deploy)

Add these secrets to your GitHub repo (**Settings → Secrets → Actions**):

| Secret | Where to find it |
|--------|-----------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare Dashboard → My Profile → API Tokens → Create Token (Edit Cloudflare Workers template) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard → right sidebar |

`.github/workflows/deploy.yml` handles the rest on every push to `main`.

### Wrangler CLI

```bash
npm install -g wrangler
wrangler login
npm run build
wrangler pages deploy dist --project-name=compressz
```

---

## Browser Compatibility

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| Image (JPEG/PNG/WebP) | 80+ | 80+ | 14+ | 80+ |
| Image (AVIF) | 85+ | 93+ | 16.1+ | 85+ |
| PDF compress | 80+ | 80+ | 14+ | 80+ |
| FFmpeg.wasm (video/audio/GIF) | 91+ | 91+ | 15.2+* | 91+ |
| FFmpeg multithreaded (MT) | 91+ | 91+ | 15.4+ | 91+ |
| WebCodecs (GPU video) | 94+ | — | 16.4+ | 94+ |
| OCR (Tesseract.js) | 91+ | 91+ | 15.2+ | 91+ |
| OCR (PaddleOCR/WebGL) | 91+ | 91+ | 15.2+ | 91+ |

*Safari single-threaded only without COOP/COEP, which Cloudflare Pages sets via `_headers`.

---

## COOP/COEP Headers

`public/_headers` sets on every Cloudflare Pages response:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

These headers unlock `SharedArrayBuffer`, which FFmpeg.wasm uses for multithreading (~2× encode speed). Without them, FFmpeg falls back to single-threaded mode and still works correctly.

---

## License

MIT — see [LICENSE](LICENSE)
