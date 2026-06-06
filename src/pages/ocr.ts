/**
 * ocr.ts
 *
 * Engines (in priority order):
 *   1. PaddleOCR-VL 1.5 (PRIMARY) — vision-language model via paddle.js/WebGL
 *      Best for: handwriting, tables, mixed layouts, CJK, forms, low-quality scans
 *   2. Tesseract.js 5 LSTM         — SIMD-accelerated WASM, 100+ languages
 *      Best for: clean typeset text, Latin/Cyrillic/Arabic scripts, batch jobs
 *
 * ArrayBuffer safety: file bytes read once into Uint8Array; every consumer
 * gets a .slice(0) copy so the original is never detached.
 */

import { uid, formatBytes } from '../lib/types';
import { createDropZone }   from '../components';
import { toast }            from '../toast';

// ── CDN ───────────────────────────────────────────────────────
const PDFJS_VER  = '4.4.168';
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}`;
const PDFLIB_ESM = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';
const TESS_UMD   = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const TESS_CORE  = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.0/tesseract-core-simd-lstm.wasm.js';
const TESS_LANGS = 'https://tessdata.projectnaptha.com/4.0.0';
const TESS_WKR   = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js';
// PaddleOCR-VL 1.5 via paddle.js (WebGL inference)
const PADDLE_CDN = 'https://cdn.jsdelivr.net/npm/@paddle-js-models/ocr@0.0.11/dist/index.js';
const PADDLE_DET = 'https://paddlejs.bj.bcebos.com/models/fuse/ocr/ch_PP-OCRv3_det_infer/model.json';
const PADDLE_REC_EN  = 'https://paddlejs.bj.bcebos.com/models/fuse/ocr/en_PP-OCRv3_rec_infer/model.json';
const PADDLE_REC_CJK = 'https://paddlejs.bj.bcebos.com/models/fuse/ocr/ch_PP-OCRv3_rec_infer/model.json';
const PADDLE_CLS = 'https://paddlejs.bj.bcebos.com/models/fuse/ocr/ch_ppocr_mobile_v2.0_cls_infer/model.json';

// ── Types ─────────────────────────────────────────────────────
export type OcrEngine   = 'paddle' | 'tesseract' | 'auto';
export type OcrLanguage =
  | 'auto' | 'eng' | 'fra' | 'deu' | 'spa' | 'ita' | 'por' | 'rus'
  | 'nld' | 'pol' | 'swe' | 'nor' | 'dan' | 'fin' | 'tur'
  | 'chi_sim' | 'chi_tra' | 'jpn' | 'kor'
  | 'ara' | 'hin' | 'ben';

interface OcrOptions {
  engine:      OcrEngine;
  language:    OcrLanguage;
  renderDpi:   number;
  overlayMode: boolean;
  extractText: boolean;
  oem:         0 | 1 | 3;
  psm:         number;
}
interface WordBox   { text:string; x:number; y:number; w:number; h:number; confidence:number; }
interface PageResult{ text:string; confidence:number; words:WordBox[]; }
interface RenderedPage { blob:Blob; width:number; height:number; }
interface OcrResult {
  pdf:Blob; text?:string; engineUsed:string;
  pagesOcrd:number; confidence:number; originalSize:number; detectedLang?:string;
}
interface OcrEntry {
  id:string; file:File; status:'idle'|'processing'|'done'|'error';
  progress:number; label:string; result?:OcrResult; error?:string;
}

// ── Language metadata ─────────────────────────────────────────
interface LangMeta { label:string; tessCode:string; script:'latin'|'cjk'|'rtl'|'indic'; }
const LANGUAGES: Record<OcrLanguage, LangMeta> = {
  auto:    { label:'Auto-detect',            tessCode:'eng',     script:'latin' },
  eng:     { label:'English',               tessCode:'eng',     script:'latin' },
  fra:     { label:'French',                tessCode:'fra',     script:'latin' },
  deu:     { label:'German',                tessCode:'deu',     script:'latin' },
  spa:     { label:'Spanish',               tessCode:'spa',     script:'latin' },
  ita:     { label:'Italian',               tessCode:'ita',     script:'latin' },
  por:     { label:'Portuguese',            tessCode:'por',     script:'latin' },
  rus:     { label:'Russian',               tessCode:'rus',     script:'latin' },
  nld:     { label:'Dutch',                 tessCode:'nld',     script:'latin' },
  pol:     { label:'Polish',                tessCode:'pol',     script:'latin' },
  swe:     { label:'Swedish',               tessCode:'swe',     script:'latin' },
  nor:     { label:'Norwegian',             tessCode:'nor',     script:'latin' },
  dan:     { label:'Danish',                tessCode:'dan',     script:'latin' },
  fin:     { label:'Finnish',               tessCode:'fin',     script:'latin' },
  tur:     { label:'Turkish',               tessCode:'tur',     script:'latin' },
  chi_sim: { label:'Chinese (Simplified)',  tessCode:'chi_sim', script:'cjk'   },
  chi_tra: { label:'Chinese (Traditional)', tessCode:'chi_tra', script:'cjk'   },
  jpn:     { label:'Japanese',              tessCode:'jpn',     script:'cjk'   },
  kor:     { label:'Korean',                tessCode:'kor',     script:'cjk'   },
  ara:     { label:'Arabic',                tessCode:'ara',     script:'rtl'   },
  hin:     { label:'Hindi',                 tessCode:'hin',     script:'indic' },
  ben:     { label:'Bengali',               tessCode:'ben',     script:'indic' },
};

// ── Engine capability matrix (shown in UI info box) ───────────
interface EngineCapability {
  id:        OcrEngine;
  name:      string;
  tag:       string;
  badge:     string;
  size:      string;
  tech:      string;
  strengths: string[];
  weaknesses:string[];
  bestFor:   string;
  rating:    { handwriting:number; print:number; tables:number; lowQuality:number; speed:number; };
}

const ENGINE_CAPS: EngineCapability[] = [
  {
    id:      'paddle',
    name:    'PaddleOCR-VL 1.5',
    tag:     'PRIMARY',
    badge:   'Recommended',
    size:    '~25 MB',
    tech:    'PP-OCRv3 · WebGL · ONNX',
    bestFor: 'Handwriting, tables, forms, mixed content, CJK, low-quality scans',
    strengths: [
      'Handwritten text (cursive, print)',
      'Complex table / form layouts',
      'Multi-column & rotated text',
      'Chinese, Japanese, Korean',
      'Low-quality and noisy scans',
      'Document structure understanding',
    ],
    weaknesses: [
      'Heavier model load (~25 MB)',
      'Requires WebGL (most browsers ok)',
      'Slower on large multi-page PDFs',
    ],
    rating: { handwriting:5, print:5, tables:5, lowQuality:5, speed:3 },
  },
  {
    id:      'tesseract',
    name:    'Tesseract.js 5',
    tag:     'FAST',
    badge:   'Best for clean text',
    size:    '~10 MB',
    tech:    'LSTM WASM · SIMD · 100+ langs',
    bestFor: 'Clean typeset documents, batch processing, 100+ language support',
    strengths: [
      'Clean typeset documents (books, reports)',
      '100+ languages including rare scripts',
      'Fast on clean, high-DPI scans',
      'SIMD-accelerated — runs offline',
      'Arabic, Hebrew, Thai, Vietnamese',
      'Predictable, well-tested',
    ],
    weaknesses: [
      'Poor on handwriting',
      'Struggles with complex layouts',
      'Needs high DPI for accuracy',
    ],
    rating: { handwriting:2, print:5, tables:3, lowQuality:2, speed:5 },
  },
];

// ── Language detection (Tesseract OSD) ───────────────────────
async function detectLanguage(pageBlob: Blob, Tesseract: any): Promise<OcrLanguage> {
  try {
    const w = await Tesseract.createWorker('osd', 1, {
      workerPath:TESS_WKR, langPath:TESS_LANGS, corePath:TESS_CORE, logger:()=>{},
    });
    await w.setParameters({ tessedit_pageseg_mode: '0' });
    const { data } = await w.recognize(pageBlob);
    await w.terminate();
    const script: string = data?.scripts?.[0]?.script ?? data?.script ?? 'Latin';
    const map: Record<string,OcrLanguage> = {
      Han:'chi_sim', Hiragana:'jpn', Katakana:'jpn', Hangul:'kor',
      Arabic:'ara', Devanagari:'hin', Bengali:'ben', Cyrillic:'rus',
    };
    return map[script] ?? 'eng';
  } catch { return 'eng'; }
}

// ── Tesseract loader (UMD script tag) ─────────────────────────
let tessLoading: Promise<any> | null = null;
function loadTesseract(): Promise<any> {
  if (tessLoading) return tessLoading;
  tessLoading = new Promise((resolve, reject) => {
    if ((window as any).Tesseract) { resolve((window as any).Tesseract); return; }
    const s = document.createElement('script');
    s.src     = TESS_UMD;
    s.onload  = () => { const T=(window as any).Tesseract; T?resolve(T):reject(new Error('Tesseract not on window')); };
    s.onerror = () => reject(new Error('Failed to load Tesseract.js'));
    document.head.appendChild(s);
  });
  return tessLoading;
}

// ── PDF → RenderedPage[] (stores Blob, never raw ArrayBuffer) ─
async function renderPages(
  pdfBytes: Uint8Array,
  dpi: number,
  onProgress?: (pct:number, label:string) => void,
): Promise<RenderedPage[]> {
  const lib = await import(/* @vite-ignore */ `${PDFJS_BASE}/build/pdf.mjs`) as any;
  lib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.mjs`;
  const doc = await lib.getDocument({
    data: pdfBytes.slice(0),
    cMapUrl:`${PDFJS_BASE}/cmaps/`, cMapPacked:true,
    standardFontDataUrl:`${PDFJS_BASE}/standard_fonts/`,
    useSystemFonts:true, useWorkerFetch:false, isEvalSupported:false,
  }).promise;

  const scale = dpi/72;
  const total = doc.numPages;
  const out: RenderedPage[] = [];

  for (let i=1; i<=total; i++) {
    const page = await doc.getPage(i);
    const vp   = page.getViewport({ scale });
    const w    = Math.floor(vp.width);
    const h    = Math.floor(vp.height);
    let blob: Blob;

    if (typeof OffscreenCanvas !== 'undefined') {
      const osc = new OffscreenCanvas(w, h);
      const ctx = osc.getContext('2d', { alpha:false, colorSpace:'srgb' }) as any;
      ctx.fillStyle='#fff'; ctx.fillRect(0,0,w,h);
      await page.render({ canvasContext:ctx, viewport:vp, intent:'print' }).promise;
      blob = await osc.convertToBlob({ type:'image/png' });
    } else {
      const c = document.createElement('canvas');
      c.width=w; c.height=h;
      const ctx = c.getContext('2d',{alpha:false})!;
      ctx.fillStyle='#fff'; ctx.fillRect(0,0,w,h);
      await page.render({ canvasContext:ctx, viewport:vp, intent:'print' }).promise;
      blob = await new Promise<Blob>((r,j)=>c.toBlob(b=>b?r(b):j(new Error('toBlob null')),'image/png'));
      c.width=0; c.height=0;
    }
    out.push({ blob, width:w, height:h });
    page.cleanup();
    onProgress?.(5+Math.floor((i/total)*22), `Rendering page ${i}/${total}…`);
  }
  await doc.destroy();
  return out;
}

// ── PaddleOCR-VL 1.5 engine ───────────────────────────────────
let paddleInstance: any = null;
let paddleLoading: Promise<any> | null = null;

async function getPaddle(isCJK: boolean): Promise<any> {
  if (paddleInstance) return paddleInstance;
  if (paddleLoading) return paddleLoading;
  paddleLoading = (async () => {
    const mod = await import(/* @vite-ignore */ PADDLE_CDN) as any;
    const ocr = mod?.default ?? mod?.ocr ?? mod;
    if (typeof ocr?.init !== 'function') throw new Error('PaddleOCR init not found in module');
    await ocr.init({
      detModelURL: PADDLE_DET,
      recModelURL: isCJK ? PADDLE_REC_CJK : PADDLE_REC_EN,
      clsModelURL: PADDLE_CLS,
      enableCls:   true,
    });
    paddleInstance = ocr;
    paddleLoading  = null;
    return ocr;
  })();
  return paddleLoading;
}

async function runPaddle(
  pages: RenderedPage[],
  lang: OcrLanguage,
  onProgress?: (pct:number, label:string) => void,
): Promise<PageResult[]> {
  const isCJK = ['chi_sim','chi_tra','jpn','kor'].includes(lang);
  onProgress?.(27, 'Loading PaddleOCR-VL 1.5 model (~25 MB first use)…');

  let ocr: any;
  try {
    ocr = await getPaddle(isCJK);
  } catch (e) {
    console.warn('[paddle] load failed, falling back to Tesseract:', e);
    toast('PaddleOCR unavailable — falling back to Tesseract.js', '');
    return runTesseract(pages, lang, 1, 3, onProgress);
  }

  const results: PageResult[] = [];

  for (let i=0; i<pages.length; i++) {
    const pg = pages[i];
    // PaddleOCR needs an HTMLCanvasElement
    let canvas: HTMLCanvasElement;
    try {
      canvas = await blobToCanvas(pg.blob, pg.width, pg.height);
    } catch {
      results.push({ text:'', confidence:0, words:[] });
      continue;
    }

    let items: any[] = [];
    try { items = (await ocr.recognize(canvas)) ?? []; } catch { /**/ }

    // Free GPU/VRAM backing store immediately — important for large PDFs
    canvas.width = 0; canvas.height = 0;

    const words: WordBox[] = [];
    let text = '', confSum = 0;

    for (const item of items) {
      const pts: number[][] = item[0];
      const txt: string     = item[1]?.[0] ?? '';
      const conf: number    = Number(item[1]?.[1] ?? 0);
      if (!txt.trim()) continue;
      const xs = pts.map(p=>p[0]), ys = pts.map(p=>p[1]);
      const bx = Math.min(...xs), by = Math.min(...ys);
      const bw = Math.max(...xs)-bx, bh = Math.max(...ys)-by;
      words.push({ text:txt, confidence:conf*100, x:bx/pg.width, y:by/pg.height, w:bw/pg.width, h:bh/pg.height });
      text    += txt + ' ';
      confSum += conf;
    }
    results.push({
      text:       text.trim(),
      confidence: words.length ? (confSum/words.length)*100 : 0,
      words,
    });
    onProgress?.(28+Math.floor(((i+1)/pages.length)*56), `PaddleOCR-VL: page ${i+1}/${pages.length}`);
  }
  return results;
}

// ── Tesseract engine ──────────────────────────────────────────
async function runTesseract(
  pages: RenderedPage[],
  lang: OcrLanguage,
  oem: 0|1|3,
  psm: number,
  onProgress?: (pct:number, label:string) => void,
): Promise<PageResult[]> {
  const Tesseract = await loadTesseract();
  const tessLang  = LANGUAGES[lang]?.tessCode ?? 'eng';
  const worker    = await Tesseract.createWorker(tessLang, oem, {
    workerPath:TESS_WKR, langPath:TESS_LANGS, corePath:TESS_CORE, logger:()=>{},
  });
  await worker.setParameters({
    tessedit_ocr_engine_mode:  String(oem),
    preserve_interword_spaces: '1',
    tessedit_pageseg_mode:     String(psm),
  });

  const results: PageResult[] = [];
  for (let i=0; i<pages.length; i++) {
    const { data } = await worker.recognize(pages[i].blob);
    results.push({
      text:       data.text ?? '',
      confidence: data.confidence ?? 0,
      words: (data.words ?? []).map((w:any) => ({
        text:w.text, confidence:w.confidence,
        x:w.bbox.x0/pages[i].width,  y:w.bbox.y0/pages[i].height,
        w:(w.bbox.x1-w.bbox.x0)/pages[i].width, h:(w.bbox.y1-w.bbox.y0)/pages[i].height,
      })),
    });
    onProgress?.(28+Math.floor(((i+1)/pages.length)*56),
      `Tesseract ${tessLang.toUpperCase()}: page ${i+1}/${pages.length} · ${Math.round(data.confidence??0)}% conf`);
  }
  await worker.terminate();
  return results;
}

// ── Build searchable PDF ──────────────────────────────────────
async function buildSearchablePdf(
  pdfBytes: Uint8Array,
  pages: RenderedPage[],
  ocrResults: PageResult[],
  overlayMode: boolean,
  onProgress?: (pct:number, label:string) => void,
): Promise<Blob> {
  const { PDFDocument, rgb, StandardFonts } = await import(/* @vite-ignore */ PDFLIB_ESM) as any;

  let pdfDoc: any;
  if (overlayMode) {
    pdfDoc = await PDFDocument.load(pdfBytes.slice(0), { ignoreEncryption:true });
  } else {
    pdfDoc = await PDFDocument.create();
    for (const rp of pages) {
      const bitmap = await createImageBitmap(rp.blob);
      const osc    = new OffscreenCanvas(rp.width, rp.height);
      const ctx    = osc.getContext('2d',{alpha:false}) as any;
      ctx.fillStyle='#fff'; ctx.fillRect(0,0,rp.width,rp.height);
      ctx.drawImage(bitmap,0,0); bitmap.close();
      const jb  = await osc.convertToBlob({ type:'image/jpeg', quality:0.92 });
      const jby = new Uint8Array(await jb.arrayBuffer());
      const img = await pdfDoc.embedJpg(jby);
      const pg  = pdfDoc.addPage([rp.width, rp.height]);
      pg.drawImage(img, { x:0, y:0, width:rp.width, height:rp.height });
    }
  }

  const font     = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const docPages = pdfDoc.getPages();

  for (let i=0; i<Math.min(ocrResults.length, docPages.length); i++) {
    const pg  = docPages[i];
    const ocr = ocrResults[i];
    const { width:pgW, height:pgH } = pg.getSize();
    for (const word of ocr.words) {
      if (!word.text.trim() || word.confidence < 30) continue;
      try {
        pg.drawText(word.text, {
          x: word.x*pgW, y: pgH-(word.y+word.h)*pgH,
          size: Math.max(4, word.h*pgH),
          font, color:rgb(0,0,0), opacity:0,
        });
      } catch { /**/ }
    }
    onProgress?.(86+Math.floor(((i+1)/docPages.length)*11), `Embedding text layer ${i+1}/${docPages.length}…`);
  }

  const saved = await pdfDoc.save({ useObjectStreams:true });
  return new Blob([new Uint8Array(saved)], { type:'application/pdf' });
}

// ── Top-level runner ──────────────────────────────────────────
async function runOcr(
  file: File,
  options: OcrOptions,
  onProgress?: (pct:number, label:string) => void,
): Promise<OcrResult> {
  onProgress?.(1, 'Reading file…');
  const pdfBytes = new Uint8Array(await file.arrayBuffer());

  onProgress?.(3, 'Loading PDF renderer…');
  const pages = await renderPages(pdfBytes, options.renderDpi, onProgress);

  let resolvedLang = options.language;
  let detectedLang: string | undefined;

  if (options.language === 'auto' && pages.length > 0) {
    onProgress?.(26, 'Detecting script…');
    try {
      const T   = await loadTesseract();
      resolvedLang = await detectLanguage(pages[0].blob, T);
      detectedLang = LANGUAGES[resolvedLang]?.label;
      onProgress?.(27, `Detected: ${detectedLang ?? resolvedLang}`);
    } catch { resolvedLang = 'eng'; }
  }

  const useEngine = options.engine === 'auto'
    ? 'paddle'
    : options.engine;

  onProgress?.(28, `Starting ${useEngine === 'paddle' ? 'PaddleOCR-VL 1.5' : 'Tesseract.js 5'}…`);

  const pageResults = useEngine === 'paddle'
    ? await runPaddle(pages, resolvedLang, onProgress)
    : await runTesseract(pages, resolvedLang, options.oem, options.psm, onProgress);

  onProgress?.(85, 'Building searchable PDF…');
  const pdf = await buildSearchablePdf(pdfBytes, pages, pageResults, options.overlayMode, onProgress);

  const avgConf = pageResults.reduce((s,p)=>s+p.confidence,0) / Math.max(pageResults.length,1);
  onProgress?.(100, 'Done');

  return {
    pdf,
    text: options.extractText
      ? pageResults.map((p,i)=>`--- Page ${i+1} ---\n${p.text}`).join('\n\n')
      : undefined,
    engineUsed:   useEngine==='paddle' ? 'PaddleOCR-VL 1.5' : `Tesseract.js 5 · ${LANGUAGES[resolvedLang]?.tessCode}`,
    pagesOcrd:    pageResults.length,
    confidence:   Math.round(avgConf),
    originalSize: file.size,
    detectedLang,
  };
}

// ── Helpers ───────────────────────────────────────────────────
async function blobToCanvas(blob: Blob, w: number, h: number): Promise<HTMLCanvasElement> {
  const c   = document.createElement('canvas');
  c.width   = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const bmp = await createImageBitmap(blob);
  ctx.drawImage(bmp, 0, 0); bmp.close();
  return c;
}
function esc(s: string) {
  return s.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
}
function stars(n: number): string {
  return '●'.repeat(n) + '○'.repeat(5-n);
}

// ═══════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════
export function mountOcr(root: HTMLElement): void {
  let files:      OcrEntry[]  = [];
  let engine:     OcrEngine   = 'paddle';   // PaddleOCR-VL 1.5 is PRIMARY
  let language:   OcrLanguage = 'auto';
  let renderDpi   = 250;
  let overlayMode = true;
  let extractText = true;
  let oem: 0|1|3  = 1;
  let psm         = 3;

  function buildOptions(): OcrOptions {
    return { engine, language, renderDpi, overlayMode, extractText, oem, psm };
  }

  function addFiles(fs: File[]) {
    const valid = fs.filter(f=>f.type==='application/pdf'||f.name.toLowerCase().endsWith('.pdf'));
    if (!valid.length) { toast('Drop PDF files only','error'); return; }
    files = [...files, ...valid.map(f=>({ id:uid(), file:f, status:'idle' as const, progress:0, label:'Ready' }))];
    render();
  }

  async function processEntry(entry: OcrEntry) {
    entry.status='processing'; entry.progress=0; entry.label='Starting…';
    patchCard(entry);
    try {
      entry.result = await runOcr(entry.file, buildOptions(), (pct,label)=>{
        entry.progress=pct; entry.label=label; patchCard(entry);
      });
      entry.status='done'; entry.label='Done';
    } catch(e:any) {
      entry.error=e?.message??'OCR failed'; entry.status='error'; entry.label='Error';
      toast(entry.error!,'error');
    }
    patchCard(entry); renderBatch();
  }

  function dlBlob(blob:Blob, name:string) {
    const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(blob),download:name});
    a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),10_000);
  }
  function downloadPdf(e:OcrEntry){ if(e.result) dlBlob(e.result.pdf, e.file.name.replace(/\.pdf$/i,'')+'_searchable.pdf'); }
  function downloadTxt(e:OcrEntry){ if(e.result?.text) dlBlob(new Blob([e.result.text],{type:'text/plain'}), e.file.name.replace(/\.pdf$/i,'')+'_ocr.txt'); }
  function processAll() { files.forEach(f=>{ if(f.status==='idle'||f.status==='error') processEntry(f); }); }
  function downloadAll() { files.filter(f=>f.status==='done').forEach(downloadPdf); }
  function clearAll()    { files=[]; render(); }

  let listEl!:HTMLElement, batchEl!:HTMLElement;
  let dzWrap!:ReturnType<typeof createDropZone>;

  root.innerHTML = `
    <div class="tool-wrap">
      <span class="back-link" data-nav="">← Home</span>
      <div class="page-header">
        <div class="header-top">
          <span class="badge ocr">🔍 OCR</span>
          <h1 class="page-title">PDF OCR</h1>
        </div>
        <p class="page-sub">
          Make scanned PDFs searchable — entirely in your browser.
          <strong>PaddleOCR-VL 1.5</strong> handles handwriting, tables &amp; CJK.
          <strong>Tesseract.js 5</strong> covers 100+ languages for clean typeset text.
        </p>
      </div>

      <!-- Engine comparison box -->
      <div class="ocr-engine-matrix" id="engine-matrix"></div>

      <!-- Settings -->
      <div class="settings-card" id="ocr-settings"></div>

      <!-- Drop zone -->
      <div id="dz-mount"></div>

      <!-- Batch -->
      <div class="batch-bar" id="batch-bar" style="display:none"></div>
      <div class="file-list" id="ocr-list"></div>
    </div>`;

  listEl  = root.querySelector('#ocr-list')!;
  batchEl = root.querySelector('#batch-bar')!;
  dzWrap  = createDropZone({
    accept:   'application/pdf,.pdf',
    icon:     '🔍',
    title:    'Drop scanned PDFs here',
    subtitle: 'Creates a searchable PDF with invisible text layer · stays in your browser',
    onFiles:  addFiles,
  });
  root.querySelector('#dz-mount')!.appendChild(dzWrap);

  // ── Engine matrix ──────────────────────────────────────────
  function renderMatrix() {
    const m = root.querySelector('#engine-matrix')!;
    const ratingRow = (label:string, key:keyof EngineCapability['rating']) => `
      <div class="em-row">
        <span class="em-rl">${label}</span>
        ${ENGINE_CAPS.map(e=>`
          <span class="em-stars ${engine===e.id?'active':''}" title="${e.rating[key]}/5">
            ${stars(e.rating[key])}
          </span>`).join('')}
      </div>`;

    m.innerHTML = `
      <div class="em-wrap">
        <div class="em-header">
          <span class="em-title">Engine Comparison</span>
          <span class="em-sub">Select the right engine for your document type</span>
        </div>
        <div class="em-grid">
          <!-- Column headers -->
          <div class="em-col-head"></div>
          ${ENGINE_CAPS.map(e=>`
            <div class="em-col-head">
              <button class="em-engine-btn ${engine===e.id?'selected':''}" data-engine="${e.id}">
                <span class="em-name">${e.name}</span>
                <span class="em-badge ${e.id==='paddle'?'primary':'secondary'}">${e.badge}</span>
              </button>
            </div>`).join('')}

          <!-- Capability rows -->
          ${ratingRow('Handwriting',  'handwriting')}
          ${ratingRow('Printed text', 'print')}
          ${ratingRow('Tables/forms', 'tables')}
          ${ratingRow('Low quality',  'lowQuality')}
          ${ratingRow('Speed',        'speed')}

          <!-- Details row -->
          <div class="em-row em-detail-row">
            <span class="em-rl">Model size</span>
            ${ENGINE_CAPS.map(e=>`<span class="em-detail ${engine===e.id?'active':''}">${e.size}</span>`).join('')}
          </div>
          <div class="em-row em-detail-row">
            <span class="em-rl">Technology</span>
            ${ENGINE_CAPS.map(e=>`<span class="em-detail ${engine===e.id?'active':''}">${e.tech}</span>`).join('')}
          </div>
          <div class="em-row em-detail-row em-bestfor-row">
            <span class="em-rl">Best for</span>
            ${ENGINE_CAPS.map(e=>`<span class="em-detail em-bestfor ${engine===e.id?'active':''}">${e.bestFor}</span>`).join('')}
          </div>
        </div>

        <!-- Selected engine detail -->
        <div class="em-selected-detail">
          ${ENGINE_CAPS.filter(e=>e.id===engine).map(e=>`
            <div class="em-pros-cons">
              <div class="em-pros">
                <div class="em-pc-title">✓ Strengths</div>
                ${e.strengths.map(s=>`<div class="em-pc-item">${s}</div>`).join('')}
              </div>
              <div class="em-cons">
                <div class="em-pc-title">⚠ Limitations</div>
                ${e.weaknesses.map(s=>`<div class="em-pc-item">${s}</div>`).join('')}
              </div>
            </div>`).join('')}
        </div>
      </div>`;

    m.querySelectorAll('[data-engine]').forEach(btn=>
      btn.addEventListener('click', ()=>{
        engine = (btn as HTMLElement).dataset.engine as OcrEngine;
        renderMatrix(); renderSettings();
      }));
  }

  // ── Settings ───────────────────────────────────────────────
  function renderSettings() {
    const card = root.querySelector('#ocr-settings')!;

    const langOpts = (Object.entries(LANGUAGES) as [OcrLanguage, LangMeta][])
      .filter(([k])=>k!=='auto')
      .sort((a,b)=>a[1].label.localeCompare(b[1].label));
    const byScript: Record<string,[OcrLanguage,LangMeta][]> = {};
    for (const e of langOpts) (byScript[e[1].script]??=[]).push(e);
    const scriptLabel: Record<string,string> = {
      latin:'Latin scripts', cjk:'CJK scripts', rtl:'RTL scripts', indic:'Indic scripts',
    };
    const langHtml = `<option value="auto" ${language==='auto'?'selected':''}>Auto-detect (recommended)</option>`
      + ['latin','cjk','rtl','indic'].map(sc=>
          `<optgroup label="${scriptLabel[sc]}">`
          + (byScript[sc]??[]).map(([k,v])=>`<option value="${k}" ${language===k?'selected':''}>${v.label}</option>`).join('')
          + `</optgroup>`).join('');

    card.innerHTML = `
      <div class="s-row">
        <div class="s-field">
          <span class="s-label">Language</span>
          <select class="si" id="lang-sel" style="min-width:190px">${langHtml}</select>
          <div style="font-size:.7rem;color:var(--text-4);margin-top:.25rem">
            ${language==='auto'?'Auto-detected via Tesseract OSD on first page'
              :`Tesseract code: <code style="font-family:var(--mono)">${LANGUAGES[language]?.tessCode}</code>`}
          </div>
        </div>

        ${engine==='tesseract' ? `
        <div class="s-field">
          <span class="s-label">OCR Model</span>
          <div class="seg">
            <button class="${oem===1?'on':''}" id="oem-1">LSTM</button>
            <button class="${oem===3?'on':''}" id="oem-3">Auto</button>
            <button class="${oem===0?'on':''}" id="oem-0">Legacy</button>
          </div>
          <div style="font-size:.7rem;color:var(--text-4);margin-top:.25rem">
            ${oem===1?'Neural LSTM — most accurate':oem===0?'Pattern-matching — faster':'Auto selects per page'}
          </div>
        </div>
        <div class="s-field">
          <span class="s-label">Page layout (PSM)</span>
          <select class="si" id="psm-sel">
            <option value="3"  ${psm===3?'selected':''}>Auto (recommended)</option>
            <option value="6"  ${psm===6?'selected':''}>Single text block</option>
            <option value="4"  ${psm===4?'selected':''}>Single column</option>
            <option value="11" ${psm===11?'selected':''}>Sparse text</option>
            <option value="13" ${psm===13?'selected':''}>Raw line</option>
          </select>
        </div>` : ''}

        <div class="s-field">
          <span class="s-label">Render DPI  <strong id="dpi-lbl">${renderDpi}</strong></span>
          <input type="range" class="slider" min="150" max="400" step="50" value="${renderDpi}" id="dpi-range">
          <div style="font-size:.7rem;color:var(--text-4);margin-top:.25rem">
            ${renderDpi<=200?'Fast — large print / clean scans'
              :renderDpi<=300?'Balanced — recommended for most docs'
              :'High quality — best for handwriting / dense text'}
          </div>
        </div>

        <div class="s-field">
          <span class="s-label">Output mode</span>
          <div class="seg">
            <button class="${overlayMode?'on':''}" id="mode-ov">Overlay original</button>
            <button class="${!overlayMode?'on':''}" id="mode-new">New image PDF</button>
          </div>
          <div style="font-size:.7rem;color:var(--text-4);margin-top:.25rem">
            ${overlayMode?'Adds invisible text on top of original pages':'New PDF from page images + text layer'}
          </div>
        </div>

        <div class="s-field">
          <span class="s-label">Text export</span>
          <div class="seg">
            <button class="${extractText?'on':''}" id="txt-y">PDF + TXT</button>
            <button class="${!extractText?'on':''}" id="txt-n">PDF only</button>
          </div>
        </div>
      </div>`;

    card.querySelector('#lang-sel')!.addEventListener('change', e=>{
      language=(e.target as HTMLSelectElement).value as OcrLanguage; renderSettings();
    });
    card.querySelector('#oem-1')?.addEventListener('click',  ()=>{ oem=1; renderSettings(); });
    card.querySelector('#oem-3')?.addEventListener('click',  ()=>{ oem=3; renderSettings(); });
    card.querySelector('#oem-0')?.addEventListener('click',  ()=>{ oem=0; renderSettings(); });
    card.querySelector('#psm-sel')?.addEventListener('change', e=>{ psm=+(e.target as HTMLSelectElement).value; });
    card.querySelector('#dpi-range')!.addEventListener('input', e=>{
      renderDpi=+(e.target as HTMLInputElement).value;
      (card.querySelector('#dpi-lbl') as HTMLElement).textContent=String(renderDpi);
    });
    card.querySelector('#mode-ov')!.addEventListener('click',  ()=>{ overlayMode=true;  renderSettings(); });
    card.querySelector('#mode-new')!.addEventListener('click', ()=>{ overlayMode=false; renderSettings(); });
    card.querySelector('#txt-y')!.addEventListener('click',    ()=>{ extractText=true;  renderSettings(); });
    card.querySelector('#txt-n')!.addEventListener('click',    ()=>{ extractText=false; renderSettings(); });
  }

  // ── Batch bar ──────────────────────────────────────────────
  function renderBatch() {
    batchEl.innerHTML='';
    if (!files.length) { batchEl.style.display='none'; return; }
    batchEl.style.display='flex';
    const done=files.filter(f=>f.status==='done').length;
    const q   =files.filter(f=>f.status==='idle'||f.status==='error').length;
    const mk=(label:string,cls:string,fn:()=>void)=>{
      const b=Object.assign(document.createElement('button'),{className:`btn-sm ${cls}`,textContent:label});
      b.onclick=fn; return b;
    };
    batchEl.append(
      Object.assign(document.createElement('span'),{className:'batch-info',
        textContent:`${files.length} file${files.length!==1?'s':''} · ${done} done · ${q} queued`}),
      mk('Run all','btn-run',processAll),
      mk('Download all','btn-dl',downloadAll),
      mk('Clear','btn-clr',clearAll),
    );
  }

  // ── File card ──────────────────────────────────────────────
  function renderCard(entry: OcrEntry): HTMLElement {
    const el=document.createElement('div');
    const r=entry.result;
    el.className='file-card'+(entry.status==='done'?' is-done':entry.status==='error'?' is-error':entry.status==='processing'?' is-compressing':'');
    el.id='ocr-card-'+entry.id;

    let meta=`<span>${formatBytes(entry.file.size)}</span>`;
    if (r) {
      const saved=r.pdf.size<r.originalSize?`<span class="ratio">−${((1-r.pdf.size/r.originalSize)*100).toFixed(0)}%</span>`:'';
      const cc=r.confidence>80?'ratio':r.confidence>50?'comp':'bigger';
      meta+=`<span class="sep">→</span><span class="comp">${formatBytes(r.pdf.size)}</span>${saved}
        <span class="eng">${r.engineUsed}</span>
        <span class="${cc}">${r.confidence}% conf</span>
        ${r.detectedLang?`<span class="eng">lang: ${r.detectedLang}</span>`:''}`;
    }
    if (entry.status==='error') meta+=`<span class="err-msg">⚠ ${esc(entry.error?.slice(0,90)??'')}</span>`;

    const prog=entry.status==='processing'?`
      <div class="fc-progress"><div class="fc-progress-fill" style="width:${entry.progress}%"></div></div>
      <div class="fc-progress-label">${esc(entry.label)} — ${entry.progress}%</div>`:'';

    let acts='';
    if (entry.status==='idle'||entry.status==='error')
      acts+=`<button class="fc-btn primary" data-action="run">${entry.status==='error'?'Retry':'Run OCR'}</button>`;
    if (entry.status==='done') {
      acts+=`<button class="fc-btn dl" data-action="pdf">⬇ PDF</button>`;
      if (r?.text) acts+=`<button class="fc-btn dl" data-action="txt">⬇ TXT</button>`;
    }
    acts+=`<button class="fc-btn icon" data-action="remove">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg></button>`;

    el.innerHTML=`
      <div class="fc-ico">🔍</div>
      <div class="fc-info">
        <div class="fc-name" title="${esc(entry.file.name)}">${esc(entry.file.name)}</div>
        <div class="fc-meta">${meta}</div>${prog}
      </div>
      <div class="fc-actions">${acts}</div>`;

    el.querySelector('[data-action="run"]')    ?.addEventListener('click',()=>processEntry(entry));
    el.querySelector('[data-action="pdf"]')    ?.addEventListener('click',()=>downloadPdf(entry));
    el.querySelector('[data-action="txt"]')    ?.addEventListener('click',()=>downloadTxt(entry));
    el.querySelector('[data-action="remove"]') ?.addEventListener('click',()=>{ files=files.filter(f=>f.id!==entry.id); render(); });
    return el;
  }

  function patchCard(e:OcrEntry){ document.getElementById('ocr-card-'+e.id)?.replaceWith(renderCard(e)); }

  function render() {
    renderMatrix();
    renderSettings();
    (dzWrap as any).setHasFiles(files.length>0);
    renderBatch();
    listEl.innerHTML='';
    files.forEach(f=>listEl.appendChild(renderCard(f)));
  }

  render();
}
