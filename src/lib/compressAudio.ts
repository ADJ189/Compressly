import type { CompressOptions, CompressResult, AudioFormat } from './types';
import { getFFmpeg, ffFetch } from './ffmpeg';

const DEFAULT_BITRATE: Record<AudioFormat, number> = {
  mp3: 192, aac: 160, ogg: 128, opus: 96, flac: 0, wav: 0,
};

const MIME_TYPE: Record<AudioFormat, string> = {
  mp3:  'audio/mpeg',
  aac:  'audio/mp4',
  ogg:  'audio/ogg',
  opus: 'audio/ogg; codecs=opus',
  flac: 'audio/flac',
  wav:  'audio/wav',
};

export async function compressAudio(
  file: File,
  options: CompressOptions,
  onProgress?: (pct: number) => void,
): Promise<CompressResult> {
  onProgress?.(2);
  const ff = await getFFmpeg() as any;
  onProgress?.(6);

  ff.on('progress', ({ progress }: { progress: number }) =>
    onProgress?.(6 + Math.round(progress * 88)));

  const fmt  = (options.audioFormat ?? 'mp3') as AudioFormat;
  const br   = options.audioBitrate ?? DEFAULT_BITRATE[fmt];
  const ext  = file.name.match(/\.[^.]+$/)?.[0] ?? '.audio';
  const outN = `output.${fmt === 'aac' ? 'm4a' : fmt}`;

  await ff.writeFile(`input${ext}`, await ffFetch(file));

  const args: string[] = ['-i', `input${ext}`];

  switch (fmt) {
    case 'mp3':  args.push('-c:a', 'libmp3lame', '-b:a', `${br}k`); break;
    case 'aac':  args.push('-c:a', 'aac', '-b:a', `${br}k`, '-movflags', '+faststart'); break;
    case 'ogg':  args.push('-c:a', 'libvorbis', '-b:a', `${br}k`); break;
    case 'opus': args.push('-c:a', 'libopus', '-b:a', `${br}k`, '-vbr', 'on', '-compression_level', '10'); break;
    case 'flac': args.push('-c:a', 'flac', '-compression_level', '8'); break;
    case 'wav':  args.push('-c:a', 'pcm_s16le'); break;
  }

  if (options.audioSampleRate) args.push('-ar', String(options.audioSampleRate));
  if (options.stripMetadata)   args.push('-map_metadata', '-1');
  args.push('-vn', '-y', outN);

  await ff.exec(args);

  const data = await ff.readFile(outN);
  await ff.deleteFile(`input${ext}`).catch(() => {});
  await ff.deleteFile(outN).catch(() => {});

  const blob = new Blob([data.buffer as ArrayBuffer], { type: MIME_TYPE[fmt] });
  onProgress?.(100);

  return {
    blob,
    originalSize:     file.size,
    compressedSize:   blob.size,
    compressionRatio: file.size / blob.size,
    format:           `${fmt.toUpperCase()} · FFmpeg.wasm`,
  };
}
