import type { CompressOptions, CompressResult, PdfLevel } from './types';

const PDFJS_VERSION = '4.4.168';
const PDFJS_BASE    = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;
const PDFLIB_ESM    = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';

interface Preset {
  targetDpi:   number;
  jpegQuality: number;
  renderScale: number;
  stripMeta:   boolean;
  forceCanvas: boolean;
}

const PRESETS: Record<PdfLevel, Preset> = {
  low:         { targetDpi: 220, jpegQuality: 0.85, renderScale: 2.0, stripMeta: false, forceCanvas: false },
  recommended: { targetDpi: 150, jpegQuality: 0.72, renderScale: 1.5, stripMeta: false, forceCanvas: false },
  extreme:     { targetDpi:  96, jpegQuality: 0.45, renderScale: 1.0, stripMeta: true,  forceCanvas: true  },
};

// ── Public entry ──────────────────────────────────────────────
export async function compressPdf(
  file: File,
  options: CompressOptions,
  onProgress?: (pct: number) => void,
): Promise<CompressResult> {
  onProgress?.(2);

  const level        = (options.pdfCompressionLevel ?? 'recommended') as PdfLevel;
  const preset       = PRESETS[level];
  const jpegQuality  = options.quality        ?? preset.jpegQuality;
  const renderScale  = options.pdfRenderScale ?? preset.renderScale;
  const targetSizeKB = options.targetSizeKB   ?? 0;

  const { PDFDocument, PDFName, PDFRawStream } =
    await import(/* @vite-ignore */ PDFLIB_ESM) as any;
  onProgress?.(6);

  const arrayBuffer = await file.arrayBuffer();

  // Strategy A: structural — only resamples embedded images, text/vectors untouched
  if (!preset.forceCanvas) {
    try {
      const result = await structuralCompress(
        arrayBuffer, file.size, level,
        PDFDocument, PDFName, PDFRawStream,
        jpegQuality, preset.targetDpi, preset.stripMeta,
        targetSizeKB, onProgress,
      );
      if (result.compressedSize < file.size * 0.98) return result;
    } catch (e) {
      console.warn('[pdf] structural pass failed, trying canvas render:', e);
    }
  }

  // Strategy B: canvas re-render (fallback + extreme preset)
  onProgress?.(10);
  return canvasRender(
    arrayBuffer, file, level,
    jpegQuality, renderScale, preset.stripMeta, targetSizeKB,
    PDFDocument, onProgress,
  );
}

// ── Strategy A: structural image resampling ───────────────────
async function structuralCompress(
  arrayBuffer:  ArrayBuffer,
  originalSize: number,
  level:        PdfLevel,
  PDFDocument:  any,
  PDFName:      any,
  PDFRawStream: any,
  jpegQuality:  number,
  targetDpi:    number,
  stripMeta:    boolean,
  targetSizeKB: number,
  onProgress?:  (pct: number) => void,
): Promise<CompressResult> {

  const pdfDoc = await PDFDocument.load(new Uint8Array(arrayBuffer), {
    ignoreEncryption: true,
    updateMetadata:   false,
  });

  const pages = pdfDoc.getPages();
  const total = pages.length;

  for (let p = 0; p < total; p++) {
    const page      = pages[p];
    const resources = page.node.Resources();
    if (!resources) continue;

    const xObjects = resources.lookup(PDFName.of('XObject'));
    if (!xObjects) continue;

    const keys: any[] = xObjects.keys?.() ?? [];

    for (const key of keys) {
      const xObj = xObjects.lookup(key);
      if (!xObj?.dict) continue;

      const subtype = xObj.dict.lookup(PDFName.of('Subtype'));
      if (subtype?.encodedName !== '/Image') continue;

      // Skip color spaces the canvas cannot represent correctly
      const cs     = xObj.dict.lookup(PDFName.of('ColorSpace'));
      const csName = cs?.encodedName ?? cs?.toString() ?? '';
      if (/CMYK|Indexed|Separation|DeviceN/i.test(csName)) continue;

      const origW = xObj.dict.lookup(PDFName.of('Width'))?.numberValue  ?? 0;
      const origH = xObj.dict.lookup(PDFName.of('Height'))?.numberValue ?? 0;
      if (origW < 64 || origH < 64) continue; // skip tiny decorations

      let imgBlob: Blob;
      try { imgBlob = await decodeXObjectToBlob(xObj, origW, origH); }
      catch { continue; }

      // PDFs use 72pt = 1 inch. targetDpi / 72 gives the scale factor that
      // maps PDF points to target-DPI pixels. We never upscale (min 1).
      const dpiScale = Math.min(1, targetDpi / 72);
      const newW     = Math.max(1, Math.round(origW * dpiScale));
      const newH     = Math.max(1, Math.round(origH * dpiScale));

      const quality = targetSizeKB > 0
        ? Math.max(0.2, Math.min(0.92, jpegQuality * ((newW * newH) / Math.max(origW * origH, 1))))
        : jpegQuality;

      let reencoded: Uint8Array;
      try { reencoded = await reencodeToJpeg(imgBlob, newW, newH, quality); }
      catch { continue; }

      // Only replace when the new stream is actually smaller
      if (reencoded.byteLength >= imgBlob.size) continue;

      xObj.dict.set(PDFName.of('Filter'),           PDFName.of('DCTDecode'));
      xObj.dict.set(PDFName.of('Width'),            pdfDoc.context.obj(newW));
      xObj.dict.set(PDFName.of('Height'),           pdfDoc.context.obj(newH));
      xObj.dict.set(PDFName.of('ColorSpace'),       PDFName.of('DeviceRGB'));
      xObj.dict.set(PDFName.of('BitsPerComponent'), pdfDoc.context.obj(8));
      xObj.dict.delete(PDFName.of('DecodeParms'));
      xObj.dict.delete(PDFName.of('Mask'));
      xObj.dict.delete(PDFName.of('SMask'));

      // If the XObject already has a stable ref, update it in-place.
      // Otherwise register a new object and point the XObject dict entry at it.
      if (xObj.ref) {
        pdfDoc.context.assign(xObj.ref, new PDFRawStream(xObj.dict, reencoded));
      } else {
        const newRef = pdfDoc.context.register(new PDFRawStream(xObj.dict, reencoded));
        xObjects.set(key, newRef);
      }
    }

    onProgress?.(6 + Math.floor(((p + 1) / total) * 82));
  }

  if (stripMeta) stripMetadata(pdfDoc);

  onProgress?.(92);
  const bytes = await pdfDoc.save({ useObjectStreams: true, addDefaultPage: false });
  const blob  = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
  onProgress?.(100);

  return {
    blob,
    originalSize,
    compressedSize:   blob.size,
    compressionRatio: originalSize / blob.size,
    format:           `PDF · ${level} · structural`,
  };
}

// ── Decode image XObject to a Blob the canvas can read ────────
async function decodeXObjectToBlob(xObj: any, w: number, h: number): Promise<Blob> {
  const rawBytes: Uint8Array = xObj.contents ?? xObj.getContents?.() ?? new Uint8Array(0);
  if (!rawBytes.length) throw new Error('empty stream');
  // Ensure concrete ArrayBuffer — pdf-lib can return views backed by SharedArrayBuffer
  // which Blob() rejects in strict TS lib. Slice copies into a plain ArrayBuffer.
  const safeBytes = new Uint8Array(
    rawBytes.buffer instanceof ArrayBuffer
      ? rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength)
      : new Uint8Array(rawBytes).buffer
  );

  // JPEG: magic bytes FF D8
  if (rawBytes[0] === 0xFF && rawBytes[1] === 0xD8) {
    return new Blob([safeBytes], { type: 'image/jpeg' });
  }

  // Try wrapping as a generic blob and decoding (handles PNG, etc.)
  try {
    const b = new Blob([safeBytes]);
    const bmp = await createImageBitmap(b);
    bmp.close(); // just testing decodability; close immediately
    return b;
  } catch { /**/ }

  // Raw RGB/Gray pixel data — reconstruct via ImageData
  const cs       = xObj.dict.lookup?.({ encodedName: '/ColorSpace' } as any)?.encodedName ?? '/DeviceRGB';
  const channels = cs.includes('Gray') ? 1 : 3;
  if (rawBytes.length < w * h * channels) throw new Error('stream too short for stated dimensions');

  const osc     = new OffscreenCanvas(w, h);
  const ctx     = osc.getContext('2d') as OffscreenCanvasRenderingContext2D;
  const imgData = ctx.createImageData(w, h);
  const d       = imgData.data;

  for (let i = 0; i < w * h; i++) {
    if (channels === 1) {
      const v = rawBytes[i];
      d[i*4] = v; d[i*4+1] = v; d[i*4+2] = v; d[i*4+3] = 255;
    } else {
      d[i*4]   = rawBytes[i*3];
      d[i*4+1] = rawBytes[i*3+1];
      d[i*4+2] = rawBytes[i*3+2];
      d[i*4+3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return osc.convertToBlob({ type: 'image/png' });
}

// ── Re-encode blob → JPEG at target dimensions ────────────────
async function reencodeToJpeg(blob: Blob, w: number, h: number, quality: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob);
  const osc    = new OffscreenCanvas(w, h);
  const ctx    = osc.getContext('2d') as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = '#ffffff'; // flatten transparency before JPEG
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const out = await osc.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await out.arrayBuffer());
}

// ── Strategy B: full page canvas render via PDF.js ────────────
async function canvasRender(
  arrayBuffer:  ArrayBuffer,
  file:         File,
  level:        PdfLevel,
  jpegQuality:  number,
  renderScale:  number,
  stripMeta:    boolean,
  targetSizeKB: number,
  PDFDocument:  any,
  onProgress?:  (pct: number) => void,
): Promise<CompressResult> {

  const pdfjsLib = await import(/* @vite-ignore */ `${PDFJS_BASE}/build/pdf.mjs`) as any;
  pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.mjs`;
  onProgress?.(14);

  const srcDoc = await pdfjsLib.getDocument({
    data:                new Uint8Array(arrayBuffer),
    cMapUrl:             `${PDFJS_BASE}/cmaps/`,
    cMapPacked:          true,
    standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
    useSystemFonts:      true,
    useWorkerFetch:      false,
    isEvalSupported:     false,
  }).promise;
  onProgress?.(18);

  const newPdf = await PDFDocument.create();
  const total  = srcDoc.numPages;
  const hasOSC = typeof OffscreenCanvas !== 'undefined';

  for (let i = 1; i <= total; i++) {
    const page = await srcDoc.getPage(i);
    const vp   = page.getViewport({ scale: renderScale });
    const w    = Math.floor(vp.width);
    const h    = Math.floor(vp.height);

    let jpegBytes: Uint8Array;

    if (hasOSC) {
      const osc = new OffscreenCanvas(w, h);
      const ctx = osc.getContext('2d', { alpha: false, colorSpace: 'srgb' }) as any;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;

      const q       = targetSizeKB > 0
        ? await oscBinarySearch(osc, (targetSizeKB * 1024) / total)
        : jpegQuality;
      const outBlob = await osc.convertToBlob({ type: 'image/jpeg', quality: q });
      jpegBytes     = new Uint8Array(await outBlob.arrayBuffer());
    } else {
      const canvas  = document.createElement('canvas');
      canvas.width  = w; canvas.height = h;
      const ctx     = canvas.getContext('2d', { alpha: false })!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;

      const q   = targetSizeKB > 0
        ? await canvasBinarySearch(canvas, (targetSizeKB * 1024) / total)
        : jpegQuality;
      const d   = canvas.toDataURL('image/jpeg', q);
      jpegBytes = base64ToBytes(d.replace(/^data:image\/jpeg;base64,/, ''));
      canvas.width = 0; canvas.height = 0;
    }

    const img     = await (newPdf as any).embedJpg(jpegBytes);
    const newPage = (newPdf as any).addPage([w, h]);
    newPage.drawImage(img, { x: 0, y: 0, width: w, height: h });
    page.cleanup();

    onProgress?.(18 + Math.floor((i / total) * 76));
  }

  await srcDoc.destroy();
  onProgress?.(96);

  if (stripMeta) stripMetadata(newPdf);

  const bytes = await (newPdf as any).save({ useObjectStreams: true, addDefaultPage: false });
  const blob  = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });

  if (blob.size < 256) throw new Error(`Output too small (${blob.size}b) — PDF may be corrupt`);

  onProgress?.(100);
  return {
    blob,
    originalSize:     file.size,
    compressedSize:   blob.size,
    compressionRatio: file.size / blob.size,
    format:           `PDF · ${level} · canvas`,
  };
}

// ── Binary search helpers ─────────────────────────────────────
async function oscBinarySearch(osc: OffscreenCanvas, targetBytes: number): Promise<number> {
  let lo = 0.20, hi = 0.92, best = 0.60;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    const b   = await osc.convertToBlob({ type: 'image/jpeg', quality: mid });
    if (b.size <= targetBytes) { best = mid; lo = mid; } else hi = mid;
    if (hi - lo < 0.01) break;
  }
  return best;
}

async function canvasBinarySearch(canvas: HTMLCanvasElement, targetBytes: number): Promise<number> {
  let lo = 0.20, hi = 0.92, best = 0.60;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    const d   = canvas.toDataURL('image/jpeg', mid);
    const sz  = Math.round((d.length - 'data:image/jpeg;base64,'.length) * 3 / 4);
    if (sz <= targetBytes) { best = mid; lo = mid; } else hi = mid;
    if (hi - lo < 0.01) break;
  }
  return best;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function stripMetadata(doc: any) {
  try {
    doc.setTitle(''); doc.setAuthor(''); doc.setSubject('');
    doc.setKeywords([]); doc.setProducer(''); doc.setCreator('');
  } catch { /**/ }
}
