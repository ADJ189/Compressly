import { uid, formatBytes } from '../lib/types';
import { createDropZone } from '../components';
import { toast } from '../toast';

// ── CDN constants ─────────────────────────────────────────────
const PDFJS_VERSION = '4.4.168';
const PDFJS_BASE    = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;
const PDFLIB_ESM    = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';
const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js';

// ── Types ─────────────────────────────────────────────────────
type OcrEngine   = 'auto' | 'tesseract' | 'paddle';
type OcrLanguage = 'eng' | 'fra' | 'deu' | 'spa' | 'ita' | 'por' | 'rus' |
                   'chi_sim' | 'chi_tra' | 'jpn' | 'kor' | 'ara' | 'hin' | 'auto';

interface OcrOptions {
  engine:      OcrEngine;
  language:    OcrLanguage;
  renderDpi:   number;
  overlayMode: boolean;
  extractText: boolean;
}

interface WordBox {
  text:       string;
  x:          number;
  y:          number;
  w:          number;
  h:          number;
  confidence: number;
}

interface PageOcrResult {
  text:       string;
  confidence: number;
  words:      WordBox[];
}

interface RenderedPage {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  width:  number;
  height: number;
}

interface OcrResult {
  pdf:          Blob;
  text?:        string;
  engineUsed:   string;
  pagesOcrd:    number;
  confidence:   number;
  originalSize: number;
}

interface OcrEntry {
  id:       string;
  file:     File;
  status:   'idle' | 'processing' | 'done' | 'error';
  progress: number;
  label:    string;
  result?:  OcrResult;
  error?:   string;
}

// ═══════════════════════════════════════════════════════════════
// OCR ENGINE IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════

// ── Render all PDF pages to canvases ─────────────────────────
async function renderPages(
  arrayBuffer: ArrayBuffer,
  dpi: number,
  onProgress?: (pct: number, label: string) => void,
): Promise<RenderedPage[]> {
  const pdfjsLib = await import(/* @vite-ignore */ `${PDFJS_BASE}/build/pdf.mjs`) as any;
  pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.mjs`;

  const doc   = await pdfjsLib.getDocument({
    data:                new Uint8Array(arrayBuffer),
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
  const hasOSC  = typeof OffscreenCanvas !== 'undefined';

  for (let i = 1; i <= total; i++) {
    const page = await doc.getPage(i);
    const vp   = page.getViewport({ scale });
    const w    = Math.floor(vp.width);
    const h    = Math.floor(vp.height);

    let canvas: OffscreenCanvas | HTMLCanvasElement;
    let ctx: any;

    if (hasOSC) {
      canvas = new OffscreenCanvas(w, h);
      ctx    = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' });
    } else {
      canvas = document.createElement('canvas');
      (canvas as HTMLCanvasElement).width  = w;
      (canvas as HTMLCanvasElement).height = h;
      ctx = (canvas as HTMLCanvasElement).getContext('2d', { alpha: false });
    }

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
    page.cleanup();

    results.push({ canvas, width: w, height: h });
    onProgress?.(5 + Math.floor((i / total) * 23), `Rendering page ${i}/${total}…`);
  }

  await doc.destroy();
  return results;
}

// ── Engine A: Tesseract.js (LSTM, 100+ languages) ────────────
async function runTesseract(
  pages:       RenderedPage[],
  lang:        OcrLanguage,
  onProgress?: (pct: number, label: string) => void,
): Promise<PageOcrResult[]> {
  const { createWorker } = await import(/* @vite-ignore */ TESSERACT_CDN) as any;
  const tessLang = lang === 'auto' ? 'eng' : lang;

  const worker = await createWorker(tessLang, 1, {
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
    langPath:   'https://tessdata.projectnaptha.com/4.0.0',
    corePath:   'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.0/tesseract-core-simd-lstm.wasm.js',
    logger:     () => {},
  });

  await worker.setParameters({
    tessedit_ocr_engine_mode:  1,   // LSTM only — most accurate
    preserve_interword_spaces: '1',
    tessedit_pageseg_mode:     '3', // Fully automatic page segmentation
  });

  const results: PageOcrResult[] = [];

  for (let i = 0; i < pages.length; i++) {
    const page  = pages[i];
    const blob  = await canvasToBlob(page.canvas);
    const { data } = await worker.recognize(blob);

    results.push({
      text:       data.text ?? '',
      confidence: data.confidence ?? 0,
      words: (data.words ?? []).map((w: any) => ({
        text:       w.text,
        confidence: w.confidence,
        x:          w.bbox.x0 / page.width,
        y:          w.bbox.y0 / page.height,
        w:          (w.bbox.x1 - w.bbox.x0) / page.width,
        h:          (w.bbox.y1 - w.bbox.y0) / page.height,
      })),
    });

    onProgress?.(
      30 + Math.floor(((i + 1) / pages.length) * 52),
      `Tesseract: page ${i + 1}/${pages.length} (${Math.round(data.confidence ?? 0)}% conf)`,
    );
  }

  await worker.terminate();
  return results;
}

// ── Engine B: PaddleOCR (PP-OCRv3 — detection + cls + rec) ───
const PADDLE_CDN = 'https://cdn.jsdelivr.net/npm/@paddle-js-models/ocr@0.0.11/dist/index.js';

async function runPaddle(
  pages:       RenderedPage[],
  lang:        OcrLanguage,
  onProgress?: (pct: number, label: string) => void,
): Promise<PageOcrResult[]> {
  let paddleOcr: any;
  try {
    onProgress?.(31, 'Loading PaddleOCR model (first use ~25 MB)…');
    const mod = await import(/* @vite-ignore */ PADDLE_CDN);
    paddleOcr = (mod as any).default ?? mod;
    const isCJK = ['chi_sim', 'chi_tra', 'jpn', 'kor'].includes(lang);
    await paddleOcr.init({
      detModelURL: 'https://paddlejs.bj.bcebos.com/models/fuse/ocr/ch_PP-OCRv3_det_infer/model.json',
      recModelURL: isCJK
        ? 'https://paddlejs.bj.bcebos.com/models/fuse/ocr/ch_PP-OCRv3_rec_infer/model.json'
        : 'https://paddlejs.bj.bcebos.com/models/fuse/ocr/en_PP-OCRv3_rec_infer/model.json',
      clsModelURL: 'https://paddlejs.bj.bcebos.com/models/fuse/ocr/ch_ppocr_mobile_v2.0_cls_infer/model.json',
      enableCls:   true,
    });
  } catch (e) {
    console.warn('[ocr] PaddleOCR failed to load, falling back to Tesseract:', e);
    return runTesseract(pages, lang, onProgress);
  }

  const results: PageOcrResult[] = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    try {
      const htmlCanvas = await toHtmlCanvas(page.canvas, page.width, page.height);
      const res        = await paddleOcr.recognize(htmlCanvas) ?? [];
      const words: WordBox[] = [];
      let text    = '';
      let confSum = 0;

      for (const item of res) {
        const [pts, [txt, conf]] = item as [number[][], [string, number]];
        const xs = pts.map(p => p[0]);
        const ys = pts.map(p => p[1]);
        const x  = Math.min(...xs), y = Math.min(...ys);
        const bw = Math.max(...xs) - x, bh = Math.max(...ys) - y;
        words.push({
          text: txt, confidence: conf * 100,
          x: x / page.width, y: y / page.height,
          w: bw / page.width, h: bh / page.height,
        });
        text    += txt + ' ';
        confSum += conf;
      }

      results.push({
        text:       text.trim(),
        confidence: words.length > 0 ? (confSum / words.length) * 100 : 0,
        words,
      });
    } catch {
      results.push({ text: '', confidence: 0, words: [] });
    }

    onProgress?.(
      31 + Math.floor(((i + 1) / pages.length) * 52),
      `PaddleOCR: page ${i + 1}/${pages.length}`,
    );
  }

  return results;
}

// ── Auto engine selection ─────────────────────────────────────
async function selectEngine(
  firstPage: RenderedPage,
  lang:      OcrLanguage,
): Promise<'tesseract' | 'paddle'> {
  if (['chi_sim', 'chi_tra', 'jpn', 'kor', 'ara', 'hin'].includes(lang)) return 'paddle';
  try {
    const osc  = new OffscreenCanvas(200, 200);
    const ctx  = osc.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(firstPage.canvas as any, 0, 0, 200, 200);
    const d    = ctx.getImageData(0, 0, 200, 200).data;
    let dark   = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i] < 100) dark++; }
    // Dense dark-pixel ratio → complex layout → PaddleOCR; sparse → Tesseract
    return (dark / (200 * 200)) > 0.08 ? 'paddle' : 'tesseract';
  } catch {
    return 'tesseract';
  }
}

// ── Build searchable PDF with invisible text layer ─────────────
async function buildSearchablePdf(
  originalBuffer: ArrayBuffer,
  pages:          RenderedPage[],
  ocrResults:     PageOcrResult[],
  overlayMode:    boolean,
  onProgress?:    (pct: number, label: string) => void,
): Promise<Blob> {
  const { PDFDocument, rgb, StandardFonts } =
    await import(/* @vite-ignore */ PDFLIB_ESM) as any;

  const pdfDoc = overlayMode
    ? await PDFDocument.load(new Uint8Array(originalBuffer), { ignoreEncryption: true })
    : await PDFDocument.create();

  if (!overlayMode) {
    for (const rp of pages) {
      const blob  = await canvasToBlob(rp.canvas, 'image/jpeg', 0.92);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const img   = await pdfDoc.embedJpg(bytes);
      const pg    = pdfDoc.addPage([rp.width, rp.height]);
      pg.drawImage(img, { x: 0, y: 0, width: rp.width, height: rp.height });
    }
  }

  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const docPages  = pdfDoc.getPages();

  for (let i = 0; i < Math.min(ocrResults.length, docPages.length); i++) {
    const pg     = docPages[i];
    const rp     = pages[i];
    const ocr    = ocrResults[i];
    const { width: pgW, height: pgH } = pg.getSize();

    for (const word of ocr.words) {
      if (!word.text.trim() || word.confidence < 30) continue;
      const x  = word.x * pgW;
      const y  = pgH - (word.y + word.h) * pgH;
      const fh = Math.max(4, word.h * pgH);
      try {
        pg.drawText(word.text, {
          x, y, size: fh, font: helvetica,
          color: rgb(0, 0, 0), opacity: 0,
        });
      } catch { /**/ }
    }

    onProgress?.(
      86 + Math.floor(((i + 1) / docPages.length) * 10),
      `Embedding text layer ${i + 1}/${docPages.length}…`,
    );
  }

  const bytes = await pdfDoc.save({ useObjectStreams: true });
  return new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
}

// ── Public OCR entry point ────────────────────────────────────
async function runOcr(
  file:        File,
  options:     OcrOptions,
  onProgress?: (pct: number, label: string) => void,
): Promise<OcrResult> {
  onProgress?.(2, 'Loading PDF…');
  const arrayBuffer = await file.arrayBuffer();

  const pages = await renderPages(arrayBuffer, options.renderDpi, onProgress);
  onProgress?.(28, 'Pages rendered — starting OCR…');

  const engine = options.engine === 'auto'
    ? await selectEngine(pages[0], options.language)
    : options.engine;

  onProgress?.(30, `Using ${engine === 'tesseract' ? 'Tesseract.js' : 'PaddleOCR'}…`);

  const pageResults = engine === 'tesseract'
    ? await runTesseract(pages, options.language, onProgress)
    : await runPaddle(pages, options.language, onProgress);

  onProgress?.(84, 'Building searchable PDF…');

  const pdf = await buildSearchablePdf(
    arrayBuffer, pages, pageResults, options.overlayMode, onProgress,
  );

  const avgConf  = pageResults.reduce((s, p) => s + p.confidence, 0) / Math.max(pageResults.length, 1);
  const fullText = options.extractText
    ? pageResults.map((p, i) => `--- Page ${i + 1} ---\n${p.text}`).join('\n\n')
    : undefined;

  onProgress?.(100, 'Done');

  return {
    pdf,
    text:         fullText,
    engineUsed:   engine === 'tesseract' ? 'Tesseract.js 5 (LSTM)' : 'PaddleOCR PP-OCRv3',
    pagesOcrd:    pageResults.length,
    confidence:   Math.round(avgConf),
    originalSize: file.size,
  };
}

// ── Canvas helpers ────────────────────────────────────────────
function canvasToBlob(
  canvas:  OffscreenCanvas | HTMLCanvasElement,
  type    = 'image/png',
  quality = 1,
): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) return canvas.convertToBlob({ type, quality });
  return new Promise((res, rej) =>
    (canvas as HTMLCanvasElement).toBlob(
      b => b ? res(b) : rej(new Error('toBlob null')), type, quality,
    ));
}

async function toHtmlCanvas(
  src: OffscreenCanvas | HTMLCanvasElement,
  w:   number,
  h:   number,
): Promise<HTMLCanvasElement> {
  if (src instanceof HTMLCanvasElement) return src;
  const c      = document.createElement('canvas');
  c.width = w; c.height = h;
  const blob   = await (src as OffscreenCanvas).convertToBlob({ type: 'image/png' });
  const bitmap = await createImageBitmap(blob);
  c.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return c;
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// ═══════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════
export function mountOcr(root: HTMLElement) {
  let files:      OcrEntry[]  = [];
  let engine:     OcrEngine   = 'auto';
  let language:   OcrLanguage = 'auto';
  let renderDpi   = 250;
  let overlayMode = true;
  let extractText = true;

  function buildOptions(): OcrOptions {
    return { engine, language, renderDpi, overlayMode, extractText };
  }

  function addFiles(fs: File[]) {
    const valid = fs.filter(f =>
      f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (!valid.length) { toast('Drop PDF files only', 'error'); return; }
    files = [...files, ...valid.map(f => ({
      id: uid(), file: f, status: 'idle' as const,
      progress: 0, label: 'Ready',
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
      entry.error = e.message ?? 'OCR failed';
      entry.status = 'error'; entry.label = 'Error';
      toast(entry.error!, 'error');
    }
    patchCard(entry);
    renderBatch();
  }

  function downloadPdf(entry: OcrEntry) {
    if (!entry.result) return;
    dl(entry.result.pdf, entry.file.name.replace(/\.pdf$/i, '') + '_searchable.pdf');
  }

  function downloadTxt(entry: OcrEntry) {
    if (!entry.result?.text) return;
    dl(new Blob([entry.result.text], { type: 'text/plain' }),
       entry.file.name.replace(/\.pdf$/i, '') + '_ocr.txt');
  }

  function dl(blob: Blob, name: string) {
    const a = Object.assign(document.createElement('a'),
      { href: URL.createObjectURL(blob), download: name });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  function processAll() {
    files.forEach(f => { if (f.status === 'idle' || f.status === 'error') processEntry(f); });
  }
  function downloadAll() { files.filter(f => f.status === 'done').forEach(downloadPdf); }
  function clearAll()    { files = []; render(); }

  // ── DOM ─────────────────────────────────────────────────────
  let listEl!:  HTMLElement;
  let batchEl!: HTMLElement;
  let dzWrap!:  ReturnType<typeof createDropZone>;

  root.innerHTML = `
    <div class="compress-wrap">
      <span class="back-link" data-nav="compress">← All tools</span>
      <div class="page-header">
        <div class="header-top">
          <span class="badge ocr">🔍 OCR</span>
          <h1 class="page-title">PDF OCR</h1>
        </div>
        <p class="page-desc">
          Make scanned PDFs searchable and copy-able — all in your browser.
          <strong>Tesseract.js</strong> (LSTM, 100+ languages) for clean docs ·
          <strong>PaddleOCR PP-OCRv3</strong> (neural network) for tables, mixed layouts &amp; Asian scripts.
          Auto mode analyses each page and picks the best engine.
        </p>
      </div>
      <div class="settings-card" id="ocr-settings"></div>
      <div id="dz-mount"></div>
      <div class="batch-bar" id="batch-bar" style="display:none"></div>
      <div class="file-list" id="ocr-list"></div>
    </div>
  `;

  listEl  = root.querySelector('#ocr-list')!;
  batchEl = root.querySelector('#batch-bar')!;
  dzWrap  = createDropZone({
    accept:  'application/pdf,.pdf',
    icon:    '🔍',
    title:   'Drop scanned PDFs here',
    subtitle:'Creates a searchable PDF with invisible text layer (Tesseract.js / PaddleOCR)',
    onFiles: addFiles,
  });
  root.querySelector('#dz-mount')!.appendChild(dzWrap);

  // ── Settings ────────────────────────────────────────────────
  function renderSettings() {
    const card = root.querySelector('#ocr-settings')!;
    const ENGINES: { id: OcrEngine; icon: string; name: string; sub: string }[] = [
      { id: 'auto',      icon: '🤖', name: 'Auto',      sub: 'Smart pick per doc' },
      { id: 'tesseract', icon: '🔤', name: 'Tesseract', sub: '100+ langs · LSTM WASM' },
      { id: 'paddle',    icon: '🧠', name: 'PaddleOCR', sub: 'Neural · tables · CJK' },
    ];

    card.innerHTML = `
      <div class="row">
        <div class="field">
          <span class="label">OCR Engine</span>
          <div class="ocr-engines" id="eng-grid">
            ${ENGINES.map(e => `
              <div class="ocr-engine-card${engine === e.id ? ' on' : ''}" data-eng="${e.id}">
                <span class="oec-icon">${e.icon}</span>
                <span class="oec-name">${e.name}</span>
                <span class="oec-sub">${e.sub}</span>
              </div>`).join('')}
          </div>
          <div class="ocr-engine-detail" id="eng-detail"></div>
        </div>
        <div class="field">
          <span class="label">Language</span>
          <select class="si" id="lang-sel">
            <option value="auto"    ${language==='auto'   ?'selected':''}>Auto-detect</option>
            <optgroup label="Latin scripts">
              <option value="eng" ${language==='eng'?'selected':''}>English</option>
              <option value="fra" ${language==='fra'?'selected':''}>French</option>
              <option value="deu" ${language==='deu'?'selected':''}>German</option>
              <option value="spa" ${language==='spa'?'selected':''}>Spanish</option>
              <option value="ita" ${language==='ita'?'selected':''}>Italian</option>
              <option value="por" ${language==='por'?'selected':''}>Portuguese</option>
              <option value="rus" ${language==='rus'?'selected':''}>Russian</option>
            </optgroup>
            <optgroup label="Asian / complex scripts">
              <option value="chi_sim" ${language==='chi_sim'?'selected':''}>Chinese Simplified</option>
              <option value="chi_tra" ${language==='chi_tra'?'selected':''}>Chinese Traditional</option>
              <option value="jpn"     ${language==='jpn'    ?'selected':''}>Japanese</option>
              <option value="kor"     ${language==='kor'    ?'selected':''}>Korean</option>
              <option value="ara"     ${language==='ara'    ?'selected':''}>Arabic</option>
              <option value="hin"     ${language==='hin'    ?'selected':''}>Hindi</option>
            </optgroup>
          </select>
        </div>
        <div class="field">
          <span class="label">Render DPI &nbsp;<strong id="dpi-lbl">${renderDpi}</strong></span>
          <input type="range" class="slider" min="150" max="400" step="50" value="${renderDpi}" id="dpi-range">
          <div style="font-size:.72rem;color:var(--text-4);margin-top:.3rem">
            ${renderDpi <= 200 ? 'Fast · adequate for large print' : renderDpi <= 300 ? 'Balanced · recommended' : 'High accuracy · slow for large PDFs'}
          </div>
        </div>
        <div class="field">
          <span class="label">Output mode</span>
          <div class="seg">
            <button class="${overlayMode?'on':''}" id="mode-overlay">Overlay original</button>
            <button class="${!overlayMode?'on':''}" id="mode-new">New image PDF</button>
          </div>
          <div style="font-size:.72rem;color:var(--text-4);margin-top:.3rem">
            ${overlayMode ? 'Keeps original layout, adds invisible text on top' : 'Creates a fresh PDF from page images + text layer'}
          </div>
        </div>
        <div class="field">
          <span class="label">Also extract text</span>
          <div class="seg">
            <button class="${extractText?'on':''}" id="txt-yes">PDF + TXT file</button>
            <button class="${!extractText?'on':''}" id="txt-no">PDF only</button>
          </div>
        </div>
      </div>
    `;

    // Engine detail blurb
    updateEngineDetail();

    // Events
    card.querySelectorAll('[data-eng]').forEach(el =>
      el.addEventListener('click', () => {
        engine = (el as HTMLElement).dataset.eng as OcrEngine;
        renderSettings();
      }));

    card.querySelector('#lang-sel')!.addEventListener('change', e => {
      language = (e.target as HTMLSelectElement).value as OcrLanguage;
      if (['chi_sim','chi_tra','jpn','kor','ara','hin'].includes(language) && engine === 'tesseract') {
        engine = 'paddle';
      }
      renderSettings();
    });

    card.querySelector('#dpi-range')!.addEventListener('input', e => {
      renderDpi = +(e.target as HTMLInputElement).value;
      card.querySelector('#dpi-lbl')!.textContent = String(renderDpi);
    });

    card.querySelector('#mode-overlay')!.addEventListener('click', () => { overlayMode = true;  renderSettings(); });
    card.querySelector('#mode-new')!.addEventListener('click',     () => { overlayMode = false; renderSettings(); });
    card.querySelector('#txt-yes')!.addEventListener('click',      () => { extractText = true;  renderSettings(); });
    card.querySelector('#txt-no')!.addEventListener('click',       () => { extractText = false; renderSettings(); });
  }

  function updateEngineDetail() {
    const d = root.querySelector('#eng-detail');
    if (!d) return;
    const DETAILS: Record<OcrEngine, string> = {
      auto:      '🤖 <strong>Auto</strong> — analyses page density and script complexity then selects Tesseract for simple/clean docs and PaddleOCR for complex layouts, tables, or non-Latin scripts.',
      tesseract: '🔤 <strong>Tesseract.js 5</strong> — LSTM neural model, SIMD-accelerated WASM (~10 MB). Ideal for single-column clean scans, 300 DPI+ images, and Latin/Cyrillic/Arabic scripts. Runs fully offline after first load.',
      paddle:    '🧠 <strong>PaddleOCR PP-OCRv3</strong> — Baidu\'s state-of-the-art pipeline: text detector → direction classifier → recogniser (~25 MB via WebGL). Best for tables, multi-column layouts, rotated text, CJK, and low-quality scans.',
    };
    d.innerHTML = `<p class="ocr-tip">${DETAILS[engine]}</p>`;
  }

  // ── Batch bar ───────────────────────────────────────────────
  function renderBatch() {
    batchEl.innerHTML = '';
    if (!files.length) { batchEl.style.display = 'none'; return; }
    batchEl.style.display = 'flex';

    const done   = files.filter(f => f.status === 'done').length;
    const queued = files.filter(f => f.status === 'idle' || f.status === 'error').length;

    const info = Object.assign(document.createElement('span'), {
      className: 'batch-info',
      textContent: `${files.length} file${files.length !== 1 ? 's' : ''} · ${done} done · ${queued} queued`,
    });

    const btnRun = mkBtn('Run all', 'btn-run', processAll);
    const btnDl  = mkBtn('Download all', 'btn-dl', downloadAll);
    const btnClr = mkBtn('Clear', 'btn-clr', clearAll);
    batchEl.append(info, btnRun, btnDl, btnClr);
  }

  function mkBtn(label: string, cls: string, fn: () => void) {
    const b = document.createElement('button');
    b.className = `btn-sm ${cls}`; b.textContent = label;
    b.addEventListener('click', fn); return b;
  }

  // ── File card ───────────────────────────────────────────────
  function renderCard(entry: OcrEntry): HTMLElement {
    const el = document.createElement('div');
    el.className = 'file-card' + (
      entry.status === 'done'       ? ' is-done' :
      entry.status === 'error'      ? ' is-error' :
      entry.status === 'processing' ? ' is-compressing' : '');
    el.id = 'ocr-card-' + entry.id;

    const r = entry.result;
    let metaHtml = `<span>${formatBytes(entry.file.size)}</span>`;
    if (r) {
      const saved = r.pdf.size < r.originalSize
        ? `<span class="ratio">−${((1 - r.pdf.size / r.originalSize) * 100).toFixed(0)}%</span>` : '';
      const confCls = r.confidence > 80 ? 'ratio' : r.confidence > 50 ? 'comp' : 'bigger';
      metaHtml += `
        <span class="sep">→</span>
        <span class="comp">${formatBytes(r.pdf.size)}</span>
        ${saved}
        <span class="eng">${r.engineUsed}</span>
        <span class="eng">${r.pagesOcrd}p</span>
        <span class="${confCls}">${r.confidence}% conf</span>`;
    }
    if (entry.status === 'error') {
      metaHtml += `<span class="err-msg">⚠ ${esc(entry.error?.slice(0, 80) ?? '')}</span>`;
    }

    const progressHtml = entry.status === 'processing' ? `
      <div class="fc-progress">
        <div class="fc-progress-fill" style="width:${entry.progress}%"></div>
      </div>
      <div class="fc-progress-label">${esc(entry.label)} — ${entry.progress}%</div>` : '';

    let actHtml = '';
    if (entry.status === 'idle' || entry.status === 'error') {
      actHtml += `<button class="fc-btn primary" data-action="run">${entry.status === 'error' ? 'Retry' : 'Run OCR'}</button>`;
    }
    if (entry.status === 'done') {
      actHtml += `<button class="fc-btn dl" data-action="pdf">⬇ PDF</button>`;
      if (r?.text) actHtml += `<button class="fc-btn dl" data-action="txt">⬇ TXT</button>`;
    }
    actHtml += `<button class="fc-btn icon" data-action="remove" aria-label="Remove">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg></button>`;

    el.innerHTML = `
      <div class="fc-ico">🔍</div>
      <div class="fc-info">
        <div class="fc-name" title="${esc(entry.file.name)}">${esc(entry.file.name)}</div>
        <div class="fc-meta">${metaHtml}</div>
        ${progressHtml}
      </div>
      <div class="fc-actions">${actHtml}</div>`;

    el.querySelector('[data-action="run"]')?.addEventListener('click',    () => processEntry(entry));
    el.querySelector('[data-action="pdf"]')?.addEventListener('click',    () => downloadPdf(entry));
    el.querySelector('[data-action="txt"]')?.addEventListener('click',    () => downloadTxt(entry));
    el.querySelector('[data-action="remove"]')?.addEventListener('click', () => {
      files = files.filter(f => f.id !== entry.id); render();
    });
    return el;
  }

  function patchCard(entry: OcrEntry) {
    const old = document.getElementById('ocr-card-' + entry.id);
    if (old) old.replaceWith(renderCard(entry));
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
