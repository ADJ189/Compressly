# Compressly

> Private, browser-native file compression. No uploads. No tracking. No framework.

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

- **Vite 6** — build tool + dev server
- **TypeScript 5** — strict typed, no framework
- **FFmpeg.wasm 0.12** — compiled C FFmpeg, multithreaded via SharedArrayBuffer
- **PDF.js 4.4 + pdf-lib 1.17** — loaded from jsDelivr CDN at runtime
- **Canvas API / OffscreenCanvas** — native browser image encoding
- **WebCodecs API** — GPU video encode (Chrome/Safari tier-2)
- **MediaRecorder** — universal video fallback

---

## Local development

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build → dist/
npm run preview    # preview the build
npm run typecheck  # TypeScript check
```

---

## Deploy to Cloudflare Pages

### Cloudflare Dashboard (easiest)

1. Push repo to GitHub
2. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git
3. Select your repo and set:
   - **Framework preset:** Vite
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Node version env var:** `NODE_VERSION = 20`
4. Deploy — done. The `wrangler.json` and `public/_headers` are picked up automatically.

### GitHub Actions (auto-deploy on push)

Add these secrets to your GitHub repo (Settings → Secrets → Actions):
- `CLOUDFLARE_API_TOKEN` — Cloudflare Dashboard → My Profile → API Tokens → Create Token (use "Edit Cloudflare Workers" template)
- `CLOUDFLARE_ACCOUNT_ID` — shown in Cloudflare Dashboard right sidebar

Then every push to `main` runs `.github/workflows/deploy.yml` which builds and deploys automatically.

### Wrangler CLI

```bash
npm install -g wrangler
wrangler login
npm run build
wrangler pages deploy dist --project-name=compressly
```

---

## How COOP/COEP headers work

`public/_headers` sets on every response:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

These unlock `SharedArrayBuffer`, which FFmpeg.wasm uses for multithreading (~2× faster). Cloudflare Pages serves these headers automatically from `_headers`. Without them FFmpeg falls back to single-threaded mode (still works).

---

## Project structure

```
compressly/
├── public/
│   ├── _headers          # COOP/COEP → SharedArrayBuffer for FFmpeg MT
│   ├── _redirects        # /* → /index.html (SPA fallback)
│   ├── favicon.svg
│   ├── robots.txt
│   └── sitemap.xml
├── src/
│   ├── lib/
│   │   ├── types.ts          # Shared types + formatBytes/detectFileType
│   │   ├── compress.ts       # Central dispatcher
│   │   ├── compressImage.ts  # OffscreenCanvas, binary search
│   │   ├── compressPdf.ts    # PDF.js + pdf-lib (CDN)
│   │   ├── compressVideo.ts  # FFmpeg.wasm → WebCodecs → MediaRecorder
│   │   ├── compressAudio.ts  # FFmpeg.wasm, 6 formats
│   │   ├── compressGif.ts    # FFmpeg palettegen/paletteuse or WebM
│   │   ├── optimizeSvg.ts    # Pure TS SVG optimiser
│   │   └── ffmpeg.ts         # FFmpeg singleton (loads once, cached)
│   ├── pages/
│   │   ├── images.ts
│   │   ├── pdf.ts
│   │   ├── video.ts
│   │   ├── audio.ts
│   │   └── gif.ts
│   ├── components.ts     # DropZone + FileCard DOM builders
│   ├── router.ts         # History API SPA router (~30 lines)
│   ├── toast.ts          # Toast notifications
│   ├── style.css         # All CSS, custom properties
│   └── main.ts           # Entry — wires router, theme, nav
├── index.html            # App shell + all <template> page content
├── wrangler.json         # Cloudflare Pages config (pages_build_output_dir)
├── vite.config.ts        # Vite 6 config
├── tsconfig.json
└── package.json          # vite@^6.0.0 + typescript@^5.5.3
```

---

## License

MIT
