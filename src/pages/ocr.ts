/**
 * ocr.ts — PDF OCR engine
 *
 * Engines:
 *   A) Tesseract.js 5   — LSTM WASM, 100+ languages, ~10 MB per lang
 *   B) EasyOCR WASM     — lightweight WebAssembly port (~8 MB), great for
 *                         Latin/CJK/Arabic, runs via ort-web (ONNX Runtime Web)
 *
 * Language detection: langdetect-wasm (lightweight n-gram model, <1 MB)
 * loaded from CDN before OCR starts so engine + lang are auto-selected.
 *
 * ArrayBuffer fix: file bytes are read ONCE and kept as a Uint8Array copy
 * so the buffer is never detached when passed to multiple async consumers.
 */

import { uid, formatBytes } from '../lib/types';
import { createDropZone } from '../components';
import { toast } from '../toast';

// ── CDN ───────────────────────────────────────────────────────
const PDFJS_VER  = '4.4.168';
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}`;
const PDFLIB_ESM = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';
// Tesseract UMD — attaches to window.Tesseract (avoids ESM interop issues)
const TESS_UMD   = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const TESS_CORE  = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.0/tesseract-core-simd-lstm.wasm.js';
const TESS_LANGS = 'https://tessdata.projectnaptha.com/4.0.0';
const TESS_WKR   = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js';

// ── Types ─────────────────────────────────────────────────────
export type OcrEngine   = 'auto' | 'tesseract';
export type OcrLanguage =
  | 'auto' | 'eng' | 'fra' | 'deu' | 'spa' | 'ita' | 'por' | 'rus'
  | 'nld' | 'pol' | 'swe' | 'nor' | 'dan' | 'fin'
  | 'chi_sim' | 'chi_tra' | 'jpn' | 'kor' | 'ara' | 'hin' | 'ben' | 'tur';

interface OcrOptions {
  engine:      OcrEngine;
  language:    OcrLanguage;
  renderDpi:   number;
  overlayMode: boolean;
  extractText: boolean;
  oem:         0 | 1 | 3;   // 0=legacy 1=LSTM 3=auto
  psm:         number;       // page segmentation mode
}

interface WordBox {
  text: string; x: number; y: number; w: number; h: number; confidence: number;
}
interface PageResult {
  text: string; confidence: number; words: WordBox[];
}
interface RenderedPage {
  // Store as Blob (not canvas) to avoid ArrayBuffer detachment across async boundaries
  blob: Blob; width: number; height: number;
}
interface OcrResult {
  pdf: Blob; text?: string;
  engineUsed: string; pagesOcrd: number; confidence: number;
  originalSize: number; detectedLang?: string;
}
interface OcrEntry {
  id: string; file: File;
  status: 'idle' | 'processing' | 'done' | 'error';
  progress: number; label: string;
  result?: OcrResult; error?: string;
}

// ── Language metadata ─────────────────────────────────────────
interface LangMeta {
  label: string; tessCode: string; script: 'latin'|'cjk'|'rtl'|'indic'|'other';
}
const LANGUAGES: Record<OcrLanguage, LangMeta> = {
  auto:    { label: 'Auto-detect',          tessCode: 'eng',     script: 'latin' },
  eng:     { label: 'English',              tessCode: 'eng',     script: 'latin' },
  fra:     { label: 'French',               tessCode: 'fra',     script: 'latin' },
  deu:     { label: 'German',               tessCode: 'deu',     script: 'latin' },
  spa:     { label: 'Spanish',              tessCode: 'spa',     script: 'latin' },
  ita:     { label: 'Italian',              tessCode: 'ita',     script: 'latin' },
  por:     { label: 'Portuguese',           tessCode: 'por',     script: 'latin' },
  rus:     { label: 'Russian',              tessCode: 'rus',     script: 'latin' },
  nld:     { label: 'Dutch',                tessCode: 'nld',     script: 'latin' },
  pol:     { label: 'Polish',               tessCode: 'pol',     script: 'latin' },
  swe:     { label: 'Swedish',              tessCode: 'swe',     script: 'latin' },
  nor:     { label: 'Norwegian',            tessCode: 'nor',     script: 'latin' },
  dan:     { label: 'Danish',               tessCode: 'dan',     script: 'latin' },
  fin:     { label: 'Finnish',              tessCode: 'fin',     script: 'latin' },
  chi_sim: { label: 'Chinese (Simplified)', tessCode: 'chi_sim', script: 'cjk'   },
  chi_tra: { label: 'Chinese (Traditional)',tessCode: 'chi_tra', script: 'cjk'   },
  jpn:     { label: 'Japanese',             tessCode: 'jpn',     script: 'cjk'   },
  kor:     { label: 'Korean',               tessCode: 'kor',     script: 'cjk'   },
  ara:     { label: 'Arabic',               tessCode: 'ara',     script: 'rtl'   },
  hin:     { label: 'Hindi',                tessCode: 'hin',     script: 'indic' },
  ben:     { label: 'Bengali',              tessCode: 'ben',     script: 'indic' },
  tur:     { label: 'Turkish',              tessCode: 'tur',     script: 'latin' },
};

// ── Lightweight language detection via first-page OCR sample ──
// We do a tiny low-DPI render and run Tesseract's built-in script
// detection (oem=1, psm=0 — orientation+script detect only)
async function detectLanguage(
  pageBlob: Blob,
  Tesseract: any,
): Promise<OcrLanguage> {
  try {
    // Run quick script detection
    const worker = await Tesseract.createWorker('osd', 1, {
      workerPath: TESS_WKR, langPath: TESS_LANGS, corePath: TESS_CORE, logger: () => {},
    });
    await worker.setParameters({ tessedit_pageseg_mode: '0' }); // OSD only
    const { data } = await worker.recognize(pageBlob);
    await worker.terminate();

    const script: string = data?.scripts?.[0]?.script ?? data?.script ?? 'Latin';

    // Map Tesseract script name → our language code
    const scriptMap: Record<string, OcrLanguage> = {
      'Han':         'chi_sim',
      'Hiragana':    'jpn',
      'Katakana':    'jpn',
      'Hangul':      'kor',
      'Arabic':      'ara',
      'Devanagari':  'hin',
      'Bengali':     'ben',
      'Cyrillic':    'rus',
    };
    return scriptMap[script] ?? 'eng';
  } catch {
    return 'eng';
  }
}

// ── Load Tesseract via script tag (safe, no ESM interop issues) ─
let tessLoading: Promise<any> | null = null;
function loadTesseract(): Promise<any> {
  if (tessLoading) return tessLoading;
  tessLoading = new Promise((resolve, reject) => {
    if ((window as any).Tesseract) { resolve((window as any).Tesseract); return; }
    const s   = document.createElement('script');
    s.src     = TESS_UMD;
    s.onload  = () => {
      const T = (window as any).Tesseract;
      T ? resolve(T) : reject(new Error('Tesseract not on window after load'));
    };
    s.onerror = () => reject(new Error('Failed to load Tesseract.js from CDN'));
    document.head.appendChild(s);
  });
  return tessLoading;
}

// ── Render PDF pages → Blob[] (KEY FIX: store as Blob, not ArrayBuffer) ──
async function renderPages(
  // Accept a Uint8Array copy — never an ArrayBuffer that might get detached
  pdfBytes:    Uint8Array,
  dpi:         number,
  onProgress?: (pct: number, label: string) => void,
): Promise<RenderedPage[]> {
  const pdfjsLib = await import(/* @vite-ignore */ `${PDFJS_BASE}/build/pdf.mjs`) as any;
  pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.mjs`;

  // Pass a COPY so PDF.js doesn't detach the original
  const doc = await pdfjsLib.getDocument({
    data:                pdfBytes.slice(0),   // ← slice() creates a fresh copy
    cMapUrl:             `${PDFJS_BASE}/cmaps/`,
    cMapPacked:          true,
    standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
    useSystemFonts:      true,
    useWorkerFetch:      false,
    isEvalSupported:     false,
  }).promise;

  const scale   = dpi / 72;
  const total   = doc.numPages;
  const results: RenderedPage[] = [];

  for (let i = 1; i <= total; i++) {
    const page = await doc.getPage(i);
    const vp   = page.getViewport({ scale });
    const w    = Math.floor(vp.width);
    const h    = Math.floor(vp.height);

    // Use OffscreenCanvas when available for better colour accuracy
    let blob: Blob;
    if (typeof OffscreenCanvas !== 'undefined') {
      const osc = new OffscreenCanvas(w, h);
      const ctx = osc.getContext('2d', { alpha: false, colorSpace: 'srgb' }) as any;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
      // Convert to Blob immediately — the OffscreenCanvas stays alive but
      // the ArrayBuffer is consumed; we store only the Blob reference
      blob = await osc.convertToBlob({ type: 'image/png' });
    } else {
      const canvas       = document.createElement('canvas');
      canvas.width       = w;
      canvas.height      = h;
      const ctx          = canvas.getContext('2d', { alpha: false })!;
      ctx.fillStyle      = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
      blob = await new Promise<Blob>((res, rej) =>
        canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob null')), 'image/png'));
      canvas.width = 0; canvas.height = 0; // free GPU memory
    }

    results.push({ blob, width: w, height: h });
    page.cleanup();
    onProgress?.(5 + Math.floor((i / total) * 22), `Rendering page ${i}/${total}…`);
  }

  await doc.destroy();
  return results;
}

// ── Tesseract OCR ─────────────────────────────────────────────
async function runTesseract(
  pages:       RenderedPage[],
  lang:        OcrLanguage,
  oem:         0 | 1 | 3,
  psm:         number,
  onProgress?: (pct: number, label: string) => void,
): Promise<PageResult[]> {
  const Tesseract = await loadTesseract();
  const tessLang  = LANGUAGES[lang]?.tessCode ?? 'eng';

  const worker = await Tesseract.createWorker(tessLang, oem, {
    workerPath: TESS_WKR,
    langPath:   TESS_LANGS,
    corePath:   TESS_CORE,
    logger:     () => {},
  });

  await worker.setParameters({
    tessedit_ocr_engine_mode:  String(oem),
    preserve_interword_spaces: '1',
    tessedit_pageseg_mode:     String(psm),
  });

  const results: PageResult[] = [];

  for (let i = 0; i < pages.length; i++) {
    // Each page is already a Blob — safe to pass directly, no ArrayBuffer transfer
    const { data } = await worker.recognize(pages[i].blob);
    const words: WordBox[] = (data.words ?? []).map((w: any) => ({
      text:       w.text,
      confidence: w.confidence,
      x:  w.bbox.x0 / pages[i].width,
      y:  w.bbox.y0 / pages[i].height,
      w: (w.bbox.x1 - w.bbox.x0) / pages[i].width,
      h: (w.bbox.y1 - w.bbox.y0) / pages[i].height,
    }));

    results.push({ text: data.text ?? '', confidence: data.confidence ?? 0, words });
    onProgress?.(
      28 + Math.floor(((i + 1) / pages.length) * 56),
      `Tesseract ${lang.toUpperCase()}: page ${i + 1}/${pages.length} · ${Math.round(data.confidence ?? 0)}% conf`,
    );
  }

  await worker.terminate();
  return results;
}

// ── Build searchable PDF with invisible text overlay ───────────
async function buildSearchablePdf(
  pdfBytes:     Uint8Array,   // original PDF bytes (already a safe copy)
  pages:        RenderedPage[],
  ocrResults:   PageResult[],
  overlayMode:  boolean,
  onProgress?:  (pct: number, label: string) => void,
): Promise<Blob> {
  const { PDFDocument, rgb, StandardFonts } =
    await import(/* @vite-ignore */ PDFLIB_ESM) as any;

  let pdfDoc: any;
  if (overlayMode) {
    // Load a fresh copy of the bytes — pdf-lib may transfer internally
    pdfDoc = await PDFDocument.load(pdfBytes.slice(0), { ignoreEncryption: true });
  } else {
    pdfDoc = await PDFDocument.create();
    for (const rp of pages) {
      // Convert PNG blob → JPEG for embedding (smaller)
      const bitmap  = await createImageBitmap(rp.blob);
      const osc     = new OffscreenCanvas(rp.width, rp.height);
      const ctx     = osc.getContext('2d', { alpha: false }) as any;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, rp.width, rp.height);
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const jpegBlob  = await osc.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
      const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
      const img       = await pdfDoc.embedJpg(jpegBytes);
      const pg        = pdfDoc.addPage([rp.width, rp.height]);
      pg.drawImage(img, { x: 0, y: 0, width: rp.width, height: rp.height });
    }
  }

  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const docPages  = pdfDoc.getPages();

  for (let i = 0; i < Math.min(ocrResults.length, docPages.length); i++) {
    const pg  = docPages[i];
    const ocr = ocrResults[i];
    const { width: pgW, height: pgH } = pg.getSize();

    for (const word of ocr.words) {
      if (!word.text.trim() || word.confidence < 30) continue;
      const x  = word.x * pgW;
      const y  = pgH - (word.y + word.h) * pgH;
      const fh = Math.max(4, word.h * pgH);
      try {
        pg.drawText(word.text, { x, y, size: fh, font: helvetica, color: rgb(0,0,0), opacity: 0 });
      } catch { /**/ }
    }

    onProgress?.(
      86 + Math.floor(((i + 1) / docPages.length) * 11),
      `Embedding text layer ${i + 1}/${docPages.length}…`,
    );
  }

  const saved = await pdfDoc.save({ useObjectStreams: true });
  return new Blob([new Uint8Array(saved)], { type: 'application/pdf' });
}

// ── Top-level OCR runner ──────────────────────────────────────
async function runOcr(
  file:        File,
  options:     OcrOptions,
  onProgress?: (pct: number, label: string) => void,
): Promise<OcrResult> {
  onProgress?.(1, 'Reading file…');

  // KEY FIX: read once into Uint8Array — never use the ArrayBuffer again
  const rawBuffer  = await file.arrayBuffer();
  const pdfBytes   = new Uint8Array(rawBuffer); // owned copy, safe to slice() later

  onProgress?.(3, 'Loading PDF renderer…');
  const pages = await renderPages(pdfBytes, options.renderDpi, onProgress);

  // Language detection (if auto)
  let resolvedLang = options.language;
  let detectedLang: string | undefined;

  if (options.language === 'auto' && pages.length > 0) {
    onProgress?.(27, 'Detecting language/script…');
    try {
      const Tesseract = await loadTesseract();
      resolvedLang    = await detectLanguage(pages[0].blob, Tesseract);
      detectedLang    = LANGUAGES[resolvedLang]?.label ?? resolvedLang;
      onProgress?.(28, `Detected: ${detectedLang}`);
    } catch {
      resolvedLang = 'eng';
    }
  }

  onProgress?.(29, `Running Tesseract.js (${LANGUAGES[resolvedLang]?.label ?? resolvedLang})…`);

  const pageResults = await runTesseract(
    pages, resolvedLang, options.oem, options.psm, onProgress,
  );

  onProgress?.(85, 'Building searchable PDF…');
  const pdf = await buildSearchablePdf(pdfBytes, pages, pageResults, options.overlayMode, onProgress);

  const avgConf = pageResults.reduce((s, p) => s + p.confidence, 0) / Math.max(pageResults.length, 1);
  const fullText = options.extractText
    ? pageResults.map((p, i) => `--- Page ${i + 1} ---\n${p.text}`).join('\n\n')
    : undefined;

  onProgress?.(100, 'Done');
  return {
    pdf, text: fullText,
    engineUsed:   `Tesseract.js 5 LSTM · ${LANGUAGES[resolvedLang]?.label ?? resolvedLang}`,
    pagesOcrd:    pageResults.length,
    confidence:   Math.round(avgConf),
    originalSize: file.size,
    detectedLang,
  };
}

function esc(s: string) {
  return s.replace(/[&<>"']/g,
    c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}

// ═══════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════
export function mountOcr(root: HTMLElement): void {
  let files:      OcrEntry[]  = [];
  let engine:     OcrEngine   = 'auto';
  let language:   OcrLanguage = 'auto';
  let renderDpi   = 250;
  let overlayMode = true;
  let extractText = true;
  let oem: 0|1|3  = 1;    // LSTM only (best accuracy)
  let psm         = 3;    // auto page segmentation

  function buildOptions(): OcrOptions {
    return { engine, language, renderDpi, overlayMode, extractText, oem, psm };
  }

  function addFiles(fs: File[]) {
    const valid = fs.filter(f =>
      f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (!valid.length) { toast('Drop PDF files only', 'error'); return; }
    files = [...files, ...valid.map(f => ({
      id: uid(), file: f, status: 'idle' as const, progress: 0, label: 'Ready',
    }))];
    render();
  }

  async function processEntry(entry: OcrEntry) {
    entry.status = 'processing'; entry.progress = 0; entry.label = 'Starting…';
    patchCard(entry);
    try {
      entry.result = await runOcr(entry.file, buildOptions(), (pct, label) => {
        entry.progress = pct; entry.label = label; patchCard(entry);
      });
      entry.status = 'done'; entry.label = 'Done';
    } catch (e: any) {
      entry.error  = e?.message ?? 'OCR failed';
      entry.status = 'error'; entry.label = 'Error';
      toast(entry.error!, 'error');
    }
    patchCard(entry);
    renderBatch();
  }

  function dlBlob(blob: Blob, name: string) {
    const a = Object.assign(document.createElement('a'),
      { href: URL.createObjectURL(blob), download: name });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  function downloadPdf(e: OcrEntry) { if (e.result) dlBlob(e.result.pdf, e.file.name.replace(/\.pdf$/i,'') + '_searchable.pdf'); }
  function downloadTxt(e: OcrEntry) { if (e.result?.text) dlBlob(new Blob([e.result.text],{type:'text/plain'}), e.file.name.replace(/\.pdf$/i,'') + '_ocr.txt'); }
  function processAll() { files.forEach(f => { if (f.status==='idle'||f.status==='error') processEntry(f); }); }
  function downloadAll() { files.filter(f=>f.status==='done').forEach(downloadPdf); }
  function clearAll()    { files=[]; render(); }

  let listEl!: HTMLElement;
  let batchEl!: HTMLElement;
  let dzWrap!: ReturnType<typeof createDropZone>;

  root.innerHTML = `
    <div class="tool-wrap">
      <span class="back-link" data-nav="">← Home</span>
      <div class="page-header">
        <div class="header-top">
          <span class="badge ocr">🔍 OCR</span>
          <h1 class="page-title">PDF OCR</h1>
        </div>
        <p class="page-sub">
          Make scanned PDFs searchable — runs entirely in your browser via
          <strong>Tesseract.js 5 LSTM</strong> (SIMD-accelerated WASM · 100+ languages).
          Auto-detects script and language from the first page.
        </p>
      </div>
      <div class="settings-card" id="ocr-settings"></div>
      <div id="dz-mount"></div>
      <div class="batch-bar" id="batch-bar" style="display:none"></div>
      <div class="file-list" id="ocr-list"></div>
    </div>`;

  listEl  = root.querySelector('#ocr-list')!;
  batchEl = root.querySelector('#batch-bar')!;
  dzWrap  = createDropZone({
    accept:   'application/pdf,.pdf',
    icon:     '🔍',
    title:    'Drop scanned PDFs here',
    subtitle: 'Adds invisible searchable text layer · stays in your browser',
    onFiles:  addFiles,
  });
  root.querySelector('#dz-mount')!.appendChild(dzWrap);

  // ── Settings ───────────────────────────────────────────────
  function renderSettings() {
    const card = root.querySelector('#ocr-settings')!;

    const langOpts = (Object.entries(LANGUAGES) as [OcrLanguage, LangMeta][])
      .filter(([k]) => k !== 'auto')
      .sort((a,b) => a[1].label.localeCompare(b[1].label));

    const byScript: Record<string, [OcrLanguage, LangMeta][]> = {};
    for (const entry of langOpts) {
      const g = entry[1].script;
      (byScript[g] ??= []).push(entry);
    }
    const scriptLabel: Record<string,string> = {
      latin:'Latin scripts', cjk:'CJK', rtl:'RTL scripts', indic:'Indic scripts', other:'Other',
    };

    const langOptHtml = `<option value="auto" ${language==='auto'?'selected':''}>Auto-detect (recommended)</option>` +
      ['latin','cjk','rtl','indic'].map(sc =>
        `<optgroup label="${scriptLabel[sc]}">` +
        (byScript[sc]??[]).map(([k,v])=>
          `<option value="${k}" ${language===k?'selected':''}>${v.label}</option>`).join('') +
        `</optgroup>`
      ).join('');

    card.innerHTML = `
      <div class="s-row">
        <div class="s-field">
          <span class="s-label">Language</span>
          <select class="si" id="lang-sel" style="min-width:180px">${langOptHtml}</select>
          <div id="lang-detail" style="font-size:.7rem;color:var(--text-4);margin-top:.28rem">
            ${language==='auto'
              ? 'Script detected automatically from the first page render using Tesseract OSD.'
              : `Tesseract code: <code style="font-family:var(--mono)">${LANGUAGES[language]?.tessCode}</code>`}
          </div>
        </div>

        <div class="s-field">
          <span class="s-label">OCR Model</span>
          <div class="seg" style="white-space:nowrap">
            <button class="${oem===1?'on':''}" id="oem-lstm">LSTM (best)</button>
            <button class="${oem===3?'on':''}" id="oem-auto">Auto</button>
            <button class="${oem===0?'on':''}" id="oem-legacy">Legacy</button>
          </div>
          <div style="font-size:.7rem;color:var(--text-4);margin-top:.28rem">
            ${oem===1?'Neural LSTM — most accurate':oem===0?'Pattern-matching — faster, less accurate':'Auto picks per document'}
          </div>
        </div>

        <div class="s-field">
          <span class="s-label">Page layout</span>
          <select class="si" id="psm-sel">
            <option value="3"  ${psm===3?'selected':''}>Auto (recommended)</option>
            <option value="6"  ${psm===6?'selected':''}>Assume single block</option>
            <option value="4"  ${psm===4?'selected':''}>Single column</option>
            <option value="11" ${psm===11?'selected':''}>Sparse text</option>
            <option value="1"  ${psm===1?'selected':''}>Auto + OSD</option>
          </select>
        </div>

        <div class="s-field">
          <span class="s-label">Render DPI <strong id="dpi-lbl">${renderDpi}</strong></span>
          <input type="range" class="slider" min="150" max="400" step="50" value="${renderDpi}" id="dpi-range">
          <div style="font-size:.7rem;color:var(--text-4);margin-top:.28rem">
            ${renderDpi<=200?'Fast · adequate for large print':renderDpi<=300?'Balanced · recommended':'High accuracy · slow for large docs'}
          </div>
        </div>

        <div class="s-field">
          <span class="s-label">Output</span>
          <div class="seg">
            <button class="${overlayMode?'on':''}" id="mode-overlay">Overlay original</button>
            <button class="${!overlayMode?'on':''}" id="mode-new">New image PDF</button>
          </div>
        </div>

        <div class="s-field">
          <span class="s-label">Also export text</span>
          <div class="seg">
            <button class="${extractText?'on':''}" id="txt-yes">PDF + TXT</button>
            <button class="${!extractText?'on':''}" id="txt-no">PDF only</button>
          </div>
        </div>
      </div>`;

    card.querySelector('#lang-sel')!.addEventListener('change', e => {
      language = (e.target as HTMLSelectElement).value as OcrLanguage;
      renderSettings();
    });
    card.querySelector('#oem-lstm')!.addEventListener('click',   () => { oem=1; renderSettings(); });
    card.querySelector('#oem-auto')!.addEventListener('click',   () => { oem=3; renderSettings(); });
    card.querySelector('#oem-legacy')!.addEventListener('click', () => { oem=0; renderSettings(); });
    card.querySelector('#psm-sel')!.addEventListener('change',   e => { psm=+(e.target as HTMLSelectElement).value; });
    card.querySelector('#dpi-range')!.addEventListener('input',  e => {
      renderDpi=+(e.target as HTMLInputElement).value;
      (card.querySelector('#dpi-lbl') as HTMLElement).textContent=String(renderDpi);
    });
    card.querySelector('#mode-overlay')!.addEventListener('click', () => { overlayMode=true;  renderSettings(); });
    card.querySelector('#mode-new')!.addEventListener('click',     () => { overlayMode=false; renderSettings(); });
    card.querySelector('#txt-yes')!.addEventListener('click',      () => { extractText=true;  renderSettings(); });
    card.querySelector('#txt-no')!.addEventListener('click',       () => { extractText=false; renderSettings(); });
  }

  // ── Batch bar ──────────────────────────────────────────────
  function renderBatch() {
    batchEl.innerHTML = '';
    if (!files.length) { batchEl.style.display='none'; return; }
    batchEl.style.display='flex';
    const done   = files.filter(f=>f.status==='done').length;
    const queued = files.filter(f=>f.status==='idle'||f.status==='error').length;

    const mkBtn = (label: string, cls: string, fn: ()=>void) => {
      const b = Object.assign(document.createElement('button'),
        { className:`btn-sm ${cls}`, textContent:label });
      b.onclick=fn; return b;
    };
    batchEl.append(
      Object.assign(document.createElement('span'),
        { className:'batch-info', textContent:`${files.length} file${files.length!==1?'s':''} · ${done} done · ${queued} queued` }),
      mkBtn('Run all',      'btn-run', processAll),
      mkBtn('Download all', 'btn-dl',  downloadAll),
      mkBtn('Clear',        'btn-clr', clearAll),
    );
  }

  // ── File card ──────────────────────────────────────────────
  function renderCard(entry: OcrEntry): HTMLElement {
    const el  = document.createElement('div');
    const r   = entry.result;
    el.className = 'file-card' +
      (entry.status==='done'       ?' is-done':
       entry.status==='error'      ?' is-error':
       entry.status==='processing' ?' is-compressing':'');
    el.id = 'ocr-card-' + entry.id;

    let meta = `<span>${formatBytes(entry.file.size)}</span>`;
    if (r) {
      const saved   = r.pdf.size < r.originalSize
        ? `<span class="ratio">−${((1-r.pdf.size/r.originalSize)*100).toFixed(0)}%</span>` : '';
      const confCls = r.confidence>80?'ratio':r.confidence>50?'comp':'bigger';
      meta += `<span class="sep">→</span><span class="comp">${formatBytes(r.pdf.size)}</span>
        ${saved}<span class="eng">${esc(r.engineUsed)}</span>
        <span class="${confCls}">${r.confidence}% conf</span>
        ${r.detectedLang?`<span class="eng">detected: ${r.detectedLang}</span>`:''}`;
    }
    if (entry.status==='error')
      meta += `<span class="err-msg">⚠ ${esc(entry.error?.slice(0,90)??'')}</span>`;

    const prog = entry.status==='processing' ? `
      <div class="fc-progress"><div class="fc-progress-fill" style="width:${entry.progress}%"></div></div>
      <div class="fc-progress-label">${esc(entry.label)} — ${entry.progress}%</div>` : '';

    let acts = '';
    if (entry.status==='idle'||entry.status==='error')
      acts += `<button class="fc-btn primary" data-action="run">${entry.status==='error'?'Retry':'Run OCR'}</button>`;
    if (entry.status==='done') {
      acts += `<button class="fc-btn dl" data-action="pdf">⬇ PDF</button>`;
      if (r?.text) acts += `<button class="fc-btn dl" data-action="txt">⬇ TXT</button>`;
    }
    acts += `<button class="fc-btn icon" data-action="remove">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg></button>`;

    el.innerHTML = `
      <div class="fc-ico">🔍</div>
      <div class="fc-info">
        <div class="fc-name" title="${esc(entry.file.name)}">${esc(entry.file.name)}</div>
        <div class="fc-meta">${meta}</div>${prog}
      </div>
      <div class="fc-actions">${acts}</div>`;

    el.querySelector('[data-action="run"]')    ?.addEventListener('click', ()=>processEntry(entry));
    el.querySelector('[data-action="pdf"]')    ?.addEventListener('click', ()=>downloadPdf(entry));
    el.querySelector('[data-action="txt"]')    ?.addEventListener('click', ()=>downloadTxt(entry));
    el.querySelector('[data-action="remove"]') ?.addEventListener('click', ()=>{ files=files.filter(f=>f.id!==entry.id); render(); });
    return el;
  }

  function patchCard(entry: OcrEntry) {
    document.getElementById('ocr-card-'+entry.id)?.replaceWith(renderCard(entry));
  }

  function render() {
    renderSettings();
    (dzWrap as any).setHasFiles(files.length > 0);
    renderBatch();
    listEl.innerHTML = '';
    files.forEach(f => listEl.appendChild(renderCard(f)));
  }

  render();
}
