import type { CompressOptions, CompressResult } from './types';
import { getFFmpeg, ffFetch } from './ffmpeg';

export async function compressGif(
  file: File,
  options: CompressOptions,
  onProgress?: (pct: number) => void,
): Promise<CompressResult> {
  onProgress?.(2);
  const ff = await getFFmpeg() as any;
  onProgress?.(6);

  ff.on('progress', ({ progress }: { progress: number }) =>
    onProgress?.(6 + Math.round(progress * 85)));

  await ff.writeFile('input.gif', await ffFetch(file));

  let blob: Blob;
  let fmt: string;

  if (options.gifToVideo) {
    // ── Convert to WebM VP9 ──
    await ff.exec([
      '-i', 'input.gif',
      '-c:v', 'libvpx-vp9',
      '-b:v', '0',
      '-crf', '33',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-an', '-loop', '0',
      '-y', 'output.webm',
    ]);
    const d = await ff.readFile('output.webm');
    blob    = new Blob([d.buffer as ArrayBuffer], { type: 'video/webm' });
    fmt     = 'WebM VP9 (from GIF)';
    await ff.deleteFile('output.webm').catch(() => {});

  } else {
    // ── Two-pass palettegen + paletteuse (gold standard) ──
    const q      = options.quality ?? 0.82;
    const colors = Math.round(16 + q * 240);

    const scalePart = options.maxWidth ? `scale=${options.maxWidth}:-1:flags=lanczos,` : '';
    const fpsPart   = options.fps      ? `fps=${options.fps},`                          : '';
    const pre       = `${fpsPart}${scalePart}`;

    // Pass 1 — generate palette
    await ff.exec([
      '-i', 'input.gif',
      '-vf', `${pre}palettegen=max_colors=${colors}:stats_mode=diff`,
      '-y', 'palette.png',
    ]);

    // Pass 2 — apply palette with Bayer dithering
    await ff.exec([
      '-i', 'input.gif',
      '-i', 'palette.png',
      '-lavfi', `${pre}paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      '-y', 'output.gif',
    ]);

    const d = await ff.readFile('output.gif');
    blob    = new Blob([d.buffer as ArrayBuffer], { type: 'image/gif' });
    fmt     = `GIF · ${colors} colours`;
    await ff.deleteFile('palette.png').catch(() => {});
    await ff.deleteFile('output.gif').catch(() => {});
  }

  await ff.deleteFile('input.gif').catch(() => {});
  onProgress?.(100);

  return {
    blob,
    originalSize:     file.size,
    compressedSize:   blob.size,
    compressionRatio: file.size / blob.size,
    format:           `${fmt} · FFmpeg.wasm`,
  };
}
