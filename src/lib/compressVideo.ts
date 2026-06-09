import type { CompressOptions, CompressResult } from './types';
import { getFFmpeg, ffFetch, ffHasMT } from './ffmpeg';

export async function compressVideo(
  file: File,
  options: CompressOptions,
  onProgress?: (pct: number) => void,
): Promise<CompressResult> {
  // Primary: FFmpeg.wasm — best quality, all codecs, proper MP4 container.
  try { return await videoViaFFmpeg(file, options, onProgress); }
  catch (e) { console.warn('[video] FFmpeg failed, falling back to MediaRecorder:', e); }

  // Fallback: MediaRecorder — browser-native, always produces a valid container.
  // The WebCodecs path has been removed: it encoded raw H.264 NAL units with no
  // container muxer, producing blobs that no player can open. Re-enable it only
  // after integrating mp4box.js or webm-muxer for proper muxing.
  return videoViaMediaRecorder(file, options, onProgress);
}

// ── FFmpeg.wasm ───────────────────────────────────────────────
async function videoViaFFmpeg(
  file: File,
  opts: CompressOptions,
  onProgress?: (pct: number) => void,
): Promise<CompressResult> {
  // FIX 1: get actual duration BEFORE bitrate calc so we never divide by 60
  const meta = await getVideoMeta(file);
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

  if      (codec === 'h265') args.push('-c:v', 'libx265');
  else if (codec === 'vp9')  args.push('-c:v', 'libvpx-vp9');
  else if (codec === 'vp8')  args.push('-c:v', 'libvpx');
  else if (codec === 'av1')  args.push('-c:v', 'libaom-av1');
  else                       args.push('-c:v', 'libx264');

  if (opts.targetSizeKB && opts.targetSizeKB > 0) {
    // FIX 1: use actual duration instead of hardcoded 60
    const dur = Math.max(1, meta.duration);
    const br  = Math.round((opts.targetSizeKB * 8) / dur);
    args.push('-b:v', `${br}k`, '-bufsize', `${br * 2}k`, '-maxrate', `${br * 1.5}k`);
  } else {
    const q   = opts.quality ?? 0.75;
    const crf = Math.round(18 + (1 - q) * 17);
    if (codec === 'vp9' || codec === 'av1') args.push('-crf', String(crf), '-b:v', '0');
    else                                    args.push('-crf', String(crf));
  }

  const preset = opts.videoPreset ?? 'fast';
  if      (codec === 'h264' || codec === 'h265') args.push('-preset', preset);
  else if (codec === 'vp9')                      args.push('-speed', preset === 'slow' ? '1' : preset === 'fast' ? '3' : '2');

  if (opts.maxWidth) args.push('-vf', `scale='min(${opts.maxWidth},iw)':-2:flags=lanczos`);
  if (opts.fps && opts.fps > 0) args.push('-r', String(opts.fps));

  if (codec === 'h264' || codec === 'h265') args.push('-pix_fmt', 'yuv420p');
  if (codec === 'vp9') args.push('-c:a', 'libopus', '-b:a', '96k');
  else                 args.push('-c:a', 'aac', '-b:a', '128k');

  if (codec === 'h264') args.push('-movflags', '+faststart');
  args.push('-y', outN);

  await ff.exec(args);

  const data = await ff.readFile(outN);
  await ff.deleteFile(inN).catch(() => {});
  await ff.deleteFile(outN).catch(() => {});

  const blob = new Blob([data.buffer as ArrayBuffer], { type: 'video/mp4' });
  onProgress?.(100);

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

// ── MediaRecorder ─────────────────────────────────────────────
// NOTE: A WebCodecs path was removed because it concatenated raw H.264 NAL
// units without a container muxer, producing blobs no player can open.
// Re-introduce it only after adding mp4box.js or webm-muxer for proper
// muxing. The FFmpeg + MediaRecorder chain below is reliable on all browsers.
async function videoViaMediaRecorder(
  file: File,
  opts: CompressOptions,
  onProgress?: (pct: number) => void,
): Promise<CompressResult> {
  const meta = await getVideoMeta(file);
  const { width: ow, height: oh, duration } = meta;
  const bitrate = opts.targetSizeKB
    ? Math.round((opts.targetSizeKB * 1024 * 8) / Math.max(duration, 1))
    : (opts.videoBitrate ?? 1_500_000);

  const ua       = navigator.userAgent;
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
  const isFirefox = ua.includes('Firefox/');
  const types    = isSafari
    ? ['video/mp4', 'video/webm;codecs=vp9', 'video/webm']
    : isFirefox
    ? ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  const mimeType = types.find(t => MediaRecorder.isTypeSupported(t)) ?? 'video/webm';

  const url = URL.createObjectURL(file);
  // FIX 2: don't mute the video — we need its audio stream
  const vid = Object.assign(document.createElement('video'),
    { src: url, muted: false, playsInline: true, volume: 0 });
  await new Promise<void>(r => { vid.onloadedmetadata = () => r(); });

  const w      = opts.maxWidth ? Math.min(ow, opts.maxWidth) : ow;
  const h      = opts.maxWidth ? Math.round(oh * (w / ow))   : oh;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx    = canvas.getContext('2d')!;

  // FIX 2: merge canvas video stream with audio track from the video element
  const videoStream = canvas.captureStream(opts.fps ?? 30);

  // Try to get audio tracks from the hidden video element
  let combinedStream = videoStream;
  try {
    const vidStream   = (vid as any).captureStream?.() ?? null;
    const audioTracks = vidStream?.getAudioTracks() ?? [];
    if (audioTracks.length > 0) {
      combinedStream = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...audioTracks,
      ]);
    }
  } catch { /**/ }

  const rec    = new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: bitrate });
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

  rec.stop();
  vid.pause();
  URL.revokeObjectURL(url);
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
