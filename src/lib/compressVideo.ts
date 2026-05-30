import type { CompressOptions, CompressResult } from './types';
import { getFFmpeg, ffFetch, ffHasMT } from './ffmpeg';

export async function compressVideo(
  file: File,
  options: CompressOptions,
  onProgress?: (pct: number) => void,
): Promise<CompressResult> {
  // Tier 1: FFmpeg.wasm
  try { return await videoViaFFmpeg(file, options, onProgress); } catch (e) {
    console.warn('[video] FFmpeg failed, trying WebCodecs:', e);
  }
  // Tier 2: WebCodecs (Chrome/Safari GPU path)
  if (typeof VideoEncoder !== 'undefined') {
    try { return await videoViaWebCodecs(file, options, onProgress); } catch (e) {
      console.warn('[video] WebCodecs failed, falling back to MediaRecorder:', e);
    }
  }
  // Tier 3: MediaRecorder (universal fallback)
  return videoViaMediaRecorder(file, options, onProgress);
}

// ── FFmpeg.wasm ───────────────────────────────────────────────
async function videoViaFFmpeg(
  file: File,
  opts: CompressOptions,
  onProgress?: (pct: number) => void,
): Promise<CompressResult> {
  onProgress?.(2);
  const ff = await getFFmpeg() as any;
  onProgress?.(4);

  ff.on('progress', ({ progress }: { progress: number }) =>
    onProgress?.(4 + Math.round(progress * 88)));

  const ext  = file.name.match(/\.[^.]+$/)?.[0] ?? '.mp4';
  const inN  = `vin${ext}`;
  const outN = 'vout.mp4';

  await ff.writeFile(inN, await ffFetch(file));

  const codec = opts.videoCodec ?? 'h264';
  const args: string[] = ['-i', inN];

  // Codec
  if      (codec === 'h265') args.push('-c:v', 'libx265');
  else if (codec === 'vp9')  args.push('-c:v', 'libvpx-vp9');
  else if (codec === 'vp8')  args.push('-c:v', 'libvpx');
  else if (codec === 'av1')  args.push('-c:v', 'libaom-av1');
  else                       args.push('-c:v', 'libx264');

  // Quality / bitrate
  if (opts.targetSizeKB && opts.targetSizeKB > 0) {
    const br = Math.round((opts.targetSizeKB * 8) / 60);
    args.push('-b:v', `${br}k`, '-bufsize', `${br * 2}k`, '-maxrate', `${br * 1.5}k`);
  } else {
    const q   = opts.quality ?? 0.75;
    const crf = Math.round(18 + (1 - q) * 17);
    if (codec === 'vp9' || codec === 'av1') args.push('-crf', String(crf), '-b:v', '0');
    else                                    args.push('-crf', String(crf));
  }

  // Preset
  const preset = opts.videoPreset ?? 'fast';
  if      (codec === 'h264' || codec === 'h265') args.push('-preset', preset);
  else if (codec === 'vp9')                      args.push('-speed', preset === 'slow' ? '1' : preset === 'fast' ? '3' : '2');

  // Filters
  if (opts.maxWidth) args.push('-vf', `scale='min(${opts.maxWidth},iw)':-2:flags=lanczos`);
  if (opts.fps && opts.fps > 0) args.push('-r', String(opts.fps));

  // Pixel format + audio
  if (codec === 'h264' || codec === 'h265') args.push('-pix_fmt', 'yuv420p');
  if (codec === 'vp9') args.push('-c:a', 'libopus', '-b:a', '96k');
  else                 args.push('-c:a', 'aac', '-b:a', '128k');

  // Faststart for H.264
  if (codec === 'h264') args.push('-movflags', '+faststart');
  args.push('-y', outN);

  await ff.exec(args);

  const data = await ff.readFile(outN);
  await ff.deleteFile(inN).catch(() => {});
  await ff.deleteFile(outN).catch(() => {});

  const blob = new Blob([data.buffer as ArrayBuffer], { type: 'video/mp4' });
  onProgress?.(100);

  const meta = await getVideoMeta(file);
  return {
    blob,
    originalSize:     file.size,
    compressedSize:   blob.size,
    compressionRatio: file.size / blob.size,
    format:           `video/mp4 · FFmpeg.wasm${ffHasMT() ? ' MT' : ''}`,
    width:    meta.width,
    height:   meta.height,
    duration: meta.duration,
  };
}

// ── WebCodecs ─────────────────────────────────────────────────
async function videoViaWebCodecs(
  file: File,
  opts: CompressOptions,
  onProgress?: (pct: number) => void,
): Promise<CompressResult> {
  const meta    = await getVideoMeta(file);
  const { width: w, height: h, duration } = meta;
  const bitrate = opts.targetSizeKB
    ? Math.round((opts.targetSizeKB * 1024 * 8) / Math.max(duration, 1))
    : (opts.videoBitrate ?? 2_000_000);

  const codec = 'avc1.640028';
  let hw: VideoHardwareAcceleration = 'prefer-software';
  try {
    const s = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate, framerate: 30, hardwareAcceleration: 'prefer-hardware' });
    if (s.supported) hw = 'prefer-hardware';
  } catch { /**/ }

  const chunks: EncodedVideoChunk[] = [];
  const enc = new VideoEncoder({
    output: c => chunks.push(c),
    error:  e => { throw new Error(e.message); },
  });
  enc.configure({ codec, width: w, height: h, bitrate, framerate: 30, hardwareAcceleration: hw, latencyMode: 'quality' });

  const url = URL.createObjectURL(file);
  const vid  = Object.assign(document.createElement('video'), { src: url, muted: true, playsInline: true });
  await new Promise<void>((r, rej) => { vid.onloadedmetadata = () => r(); vid.onerror = () => rej(new Error('Video load failed')); });

  const fps = opts.fps ?? 30;
  const fc  = Math.ceil(duration * fps);
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx    = canvas.getContext('2d')!;

  for (let i = 0; i < fc; i++) {
    const t = i / fps; if (t >= duration) break;
    await new Promise<void>(r => { vid.onseeked = () => r(); vid.currentTime = t; });
    ctx.drawImage(vid, 0, 0, w, h);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1_000_000) });
    enc.encode(frame, { keyFrame: i % 60 === 0 });
    frame.close();
    onProgress?.(5 + Math.round((i / fc) * 88));
  }

  await enc.flush(); enc.close(); URL.revokeObjectURL(url);

  const total = chunks.reduce((a, c) => a + c.byteLength, 0);
  const buf   = new Uint8Array(total); let pos = 0;
  for (const c of chunks) { const tmp = new Uint8Array(c.byteLength); c.copyTo(tmp); buf.set(tmp, pos); pos += c.byteLength; }

  const blob = new Blob([buf], { type: 'video/mp4' });
  onProgress?.(100);
  return {
    blob,
    originalSize:     file.size,
    compressedSize:   blob.size,
    compressionRatio: file.size / blob.size,
    format:           `video/mp4 · WebCodecs (${hw === 'prefer-hardware' ? 'GPU' : 'SW'})`,
    width: w, height: h, duration,
  };
}

// ── MediaRecorder ─────────────────────────────────────────────
async function videoViaMediaRecorder(
  file: File,
  opts: CompressOptions,
  onProgress?: (pct: number) => void,
): Promise<CompressResult> {
  const meta    = await getVideoMeta(file);
  const { width: ow, height: oh, duration } = meta;
  const bitrate = opts.targetSizeKB
    ? Math.round((opts.targetSizeKB * 1024 * 8) / Math.max(duration, 1))
    : (opts.videoBitrate ?? 1_500_000);

  const ua        = navigator.userAgent;
  const isSafari  = /^((?!chrome|android).)*safari/i.test(ua);
  const isFirefox = ua.includes('Firefox/');
  const types     = isSafari
    ? ['video/mp4', 'video/webm;codecs=vp9', 'video/webm']
    : isFirefox
    ? ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  const mimeType = types.find(t => MediaRecorder.isTypeSupported(t)) ?? 'video/webm';

  const url = URL.createObjectURL(file);
  const vid  = Object.assign(document.createElement('video'), { src: url, muted: true, playsInline: true });
  await new Promise<void>(r => { vid.onloadedmetadata = () => r(); });

  const w = opts.maxWidth ? Math.min(ow, opts.maxWidth) : ow;
  const h = opts.maxWidth ? Math.round(oh * (w / ow))   : oh;
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx    = canvas.getContext('2d')!;

  const stream  = canvas.captureStream(opts.fps ?? 30);
  const rec     = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
  const chunks: Blob[] = [];
  rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  rec.start(250);
  vid.play();

  await new Promise<void>(resolve => {
    vid.ontimeupdate = () => {
      ctx.drawImage(vid, 0, 0, w, h);
      onProgress?.(5 + Math.round((vid.currentTime / Math.max(duration, 1)) * 90));
    };
    vid.onended = () => resolve();
    setTimeout(() => resolve(), (duration + 5) * 1000);
  });

  rec.stop(); vid.pause(); URL.revokeObjectURL(url);
  await new Promise<void>(r => { rec.onstop = () => r(); });

  const blob = new Blob(chunks, { type: mimeType });
  onProgress?.(100);
  return {
    blob,
    originalSize:     file.size,
    compressedSize:   blob.size,
    compressionRatio: file.size / blob.size,
    format:           `${mimeType} · MediaRecorder`,
    width: w, height: h, duration,
  };
}

// ── Utility ───────────────────────────────────────────────────
function getVideoMeta(file: File): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v   = document.createElement('video');
    v.src     = url;
    v.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve({ width: v.videoWidth || 1280, height: v.videoHeight || 720, duration: v.duration || 30 });
    };
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Cannot read video metadata')); };
  });
}
