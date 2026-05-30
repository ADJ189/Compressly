# Compressly

> Private, browser-native file compression. No uploads. No tracking. No framework.

**Live:** https://compressly.pages.dev

---

## What it compresses

| Format | Engine | Notes |
|--------|--------|-------|
| JPEG · PNG · WebP · AVIF · HEIC | Canvas API + OffscreenCanvas | GPU-accelerated, binary-search to target size |
| PDF | PDF.js 4.4 + pdf-lib 1.17 | Page-by-page canvas render + re-embed |
| MP4 · WebM · MOV · AVI · MKV | FFmpeg.wasm → WebCodecs → MediaRecorder | 3-tier fallback |
| MP3 · AAC · OGG · Opus · FLAC · WAV | FFmpeg.wasm | Also extracts audio from video |
| GIF | FFmpeg.wasm palettegen + paletteuse | Or convert to WebM VP9 |
| SVG | Pure TypeScript | Zero-dependency inline optimiser |

---

## Tech stack

- **Vite 5** — build tool, dev server
- **TypeScript 5** — strict, no `any` except CDN interop
- **FFmpeg.wasm 0.12** — compiled C/Rust FFmpeg, multithreaded via SharedArrayBuffer
- **PDF.js 4.4 + pdf-lib 1.17** — loaded from CDN at runtime
- **Canvas API / OffscreenCanvas** — native browser image encoding
- **WebCodecs API** — GPU video encode (Chrome/Safari tier-2)
- **MediaRecorder** — universal video fallback
- **No framework** — pure TypeScript DOM manipulation

---

## Local development

```bash
npm install
npm run dev
```

The dev server runs at http://localhost:5173 and sets the required COOP/COEP headers for SharedArrayBuffer (FFmpeg multithreading).

```bash
npm run build     # production build → dist/
npm run preview   # preview build locally
npm run typecheck # TypeScript type-check (no emit)
```

---

## Deploy to Cloudflare Pages

### Option A — GitHub Actions (recommended)

1. Push this repo to GitHub
2. Go to Cloudflare Dashboard → Pages → Create project → Connect to Git
3. Set:
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Node version:** `20`
4. Add secrets to GitHub (Settings → Secrets → Actions):
   - `CLOUDFLARE_API_TOKEN` — from Cloudflare Dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template
   - `CLOUDFLARE_ACCOUNT_ID` — from Cloudflare Dashboard → right sidebar

Every push to `main` will auto-deploy via `.github/workflows/deploy.yml`.

### Option B — Wrangler CLI

```bash
npm install -g wrangler
wrangler login
npm run build
wrangler pages deploy dist --project-name=compressly
```

### Option C — Cloudflare Dashboard (drag & drop)

1. `npm run build`
2. Drag the `dist/` folder into Cloudflare Pages → Upload assets

---

## Headers (SharedArrayBuffer / FFmpeg MT)

`public/_headers` sets these on every Cloudflare Pages response:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

These are required for `SharedArrayBuffer` which enables FFmpeg multithreading (~2× faster). Without them, FFmpeg falls back to single-threaded mode (still works, just slower).

---

## Project structure

```
compressly/
├── public/
│   ├── _headers          # COOP/COEP for Cloudflare Pages
│   ├── _redirects        # SPA fallback (/* → /index.html)
│   ├── favicon.svg
│   ├── robots.txt
│   └── sitemap.xml
├── src/
│   ├── lib/
│   │   ├── types.ts          # Shared types + utilities
│   │   ├── compress.ts       # Dispatcher
│   │   ├── compressImage.ts  # Canvas 2D / OffscreenCanvas
│   │   ├── compressPdf.ts    # PDF.js + pdf-lib
│   │   ├── compressVideo.ts  # FFmpeg → WebCodecs → MediaRecorder
│   │   ├── compressAudio.ts  # FFmpeg.wasm audio
│   │   ├── compressGif.ts    # FFmpeg palettegen/paletteuse
│   │   ├── optimizeSvg.ts    # Pure TS SVG optimiser
│   │   └── ffmpeg.ts         # FFmpeg singleton loader
│   ├── pages/
│   │   ├── images.ts
│   │   ├── pdf.ts
│   │   ├── video.ts
│   │   ├── audio.ts
│   │   └── gif.ts
│   ├── components.ts     # DropZone + FileCard DOM builders
│   ├── router.ts         # Lightweight History API SPA router
│   ├── toast.ts          # Toast notification helper
│   ├── style.css         # All styles (CSS custom properties)
│   └── main.ts           # App entry point — wires router + theme
├── index.html            # App shell + all page templates
├── vite.config.ts
├── tsconfig.json
└── package.json
```

---

## License

MIT
