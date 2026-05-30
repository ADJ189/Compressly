import type { CompressOptions, CompressResult, PdfLevel } from './types';

const PDF_PRESETS: Record<PdfLevel, { quality: number; scale: number }> = {
  low:         { quality: 0.85, scale: 2.0 },
  recommended: { quality: 0.60, scale: 1.5 },
  extreme:     { quality: 0.30, scale: 1.0 },
};

const PDFJS_VERSION = '4.4.168';
const PDFJS_BASE    = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;
const PDFLIB_ESM    = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';

export async function compressPdf(
  file: File,
  options: CompressOptions,
  onProgress?: (pct: number) => void,
): Promise<CompressResult> {
  onProgress?.(2);

  const level   = (options.pdfCompressionLevel ?? 'recommended') as PdfLevel;
  const preset  = PDF_PRESETS[level];
  const quality = options.quality ?? preset.quality;
  const scale   = options.pdfRenderScale ?? preset.scale;
  const imgFmt  = options.pdfImageFormat ?? 'image/jpeg';

  // ── Load PDF.js from CDN ───────────────────────────────────
  const pdfjsLib = await import(/* @vite-ignore */ `${PDFJS_BASE}/build/pdf.mjs`);
  pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.mjs`;
  onProgress?.(8);

  const arrayBuffer = await file.arrayBuffer();
  const pdfDoc = await pdfjsLib.getDocument({
    data:                new Uint8Array(arrayBuffer),
    cMapUrl:             `${PDFJS_BASE}/cmaps/`,
    cMapPacked:          true,
    standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
    useSystemFonts:      true,
  }).promise;
  onProgress?.(12);

  // ── Load pdf-lib from CDN ──────────────────────────────────
  const { PDFDocument } = await import(/* @vite-ignore */ PDFLIB_ESM);
  const newPdf = await PDFDocument.create();
  const total  = pdfDoc.numPages;

  for (let i = 1; i <= total; i++) {
    const page = await pdfDoc.getPage(i);
    const vp   = page.getViewport({ scale });

    const canvas       = document.createElement('canvas');
    canvas.width       = Math.floor(vp.width);
    canvas.height      = Math.floor(vp.height);
    const ctx          = canvas.getContext('2d', { alpha: false })!;
    ctx.fillStyle      = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise;

    let imgData: string;
    if (options.targetSizeKB && options.targetSizeKB > 0) {
      imgData = await pdfPageBinarySearch(canvas, imgFmt, (options.targetSizeKB * 1024) / total);
    } else {
      imgData = canvas.toDataURL(imgFmt, quality);
    }

    let embeddedImg: unknown;
    if (imgFmt === 'image/png') {
      const base64 = imgData.replace('data:image/png;base64,', '');
      embeddedImg  = await (newPdf as any).embedPng(base64);
    } else {
      const base64 = imgData.replace(/^data:image\/\w+;base64,/, '');
      embeddedImg  = await (newPdf as any).embedJpg(base64);
    }

    const newPage = (newPdf as any).addPage([canvas.width, canvas.height]);
    newPage.drawImage(embeddedImg, { x: 0, y: 0, width: canvas.width, height: canvas.height });

    // Free canvas memory
    canvas.width = 0; canvas.height = 0;
    page.cleanup();

    onProgress?.(12 + Math.floor((i / total) * 82));
  }

  await pdfDoc.destroy();
  onProgress?.(95);

  const bytes = await (newPdf as any).save({ useObjectStreams: true });
  const blob  = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });

  if (blob.size < 200) {
    throw new Error(`PDF output suspiciously small (${blob.size} bytes) — compression likely failed`);
  }

  onProgress?.(100);
  return {
    blob,
    originalSize:     file.size,
    compressedSize:   blob.size,
    compressionRatio: file.size / blob.size,
    format:           `PDF · ${level} · pdf-lib`,
  };
}

async function pdfPageBinarySearch(
  canvas: HTMLCanvasElement,
  fmt: string,
  targetBytes: number,
): Promise<string> {
  let lo = 0.10, hi = 0.95, best: string | null = null;
  for (let i = 0; i < 12; i++) {
    const mid  = (lo + hi) / 2;
    const d    = canvas.toDataURL(fmt, mid);
    const size = Math.round((d.length - `data:${fmt};base64,`.length) * 3 / 4);
    if (size <= targetBytes) { best = d; lo = mid; } else hi = mid;
    if (hi - lo < 0.008) break;
  }
  return best ?? canvas.toDataURL(fmt, lo);
}
