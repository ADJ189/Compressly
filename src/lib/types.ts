// ── Types ─────────────────────────────────────────────────────

export type FileType = 'image' | 'pdf' | 'video' | 'audio' | 'gif' | 'svg' | 'unknown';
export type ImageFormat = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif';
export type AudioFormat = 'mp3' | 'aac' | 'ogg' | 'opus' | 'flac' | 'wav';
export type VideoCodec  = 'h264' | 'h265' | 'vp9' | 'vp8' | 'av1';
export type PdfLevel    = 'low' | 'recommended' | 'extreme';

export interface CompressOptions {
  // Image
  quality?: number;
  targetSizeKB?: number;
  format?: ImageFormat;
  maxWidth?: number;
  maxHeight?: number;
  stripMetadata?: boolean;
  // Video
  videoBitrate?: number;
  videoCodec?: VideoCodec;
  videoPreset?: 'ultrafast' | 'fast' | 'medium' | 'slow';
  fps?: number;
  // Audio
  audioFormat?: AudioFormat;
  audioBitrate?: number;
  audioSampleRate?: number;
  // PDF
  pdfCompressionLevel?: PdfLevel;
  pdfRenderScale?: number;
  // GIF
  gifToVideo?: boolean;
}

export interface CompressResult {
  blob: Blob;
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
  format: string;
  width?: number;
  height?: number;
  duration?: number;
}

export interface FileEntry {
  id: string;
  file: File;
  type: FileType;
  status: 'idle' | 'compressing' | 'done' | 'error';
  progress: number;
  result?: CompressResult;
  error?: string;
  options: CompressOptions;
}

// ── Helpers ───────────────────────────────────────────────────

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(Math.max(0, decimals)))} ${sizes[i]}`;
}

export function detectFileType(file: File): FileType {
  const mime = file.type.toLowerCase();
  const ext  = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (mime === 'image/gif'     || ext === 'gif')                return 'gif';
  if (mime === 'image/svg+xml' || ext === 'svg')                return 'svg';
  if (mime.startsWith('image/') || ['jpg','jpeg','png','webp','avif','bmp','tiff','tif','heic','heif','ico'].includes(ext)) return 'image';
  if (mime === 'application/pdf' || ext === 'pdf')              return 'pdf';
  if (mime.startsWith('video/') || ['mp4','webm','mov','avi','mkv','m4v','flv','wmv','ogv','3gp'].includes(ext)) return 'video';
  if (mime.startsWith('audio/') || ['mp3','aac','ogg','opus','flac','wav','m4a','wma','aiff','aif'].includes(ext)) return 'audio';
  return 'unknown';
}

export function getOutputExtension(result: CompressResult): string {
  // Primary: derive from the actual blob MIME type — always authoritative.
  const mime = result.blob.type.toLowerCase();
  if (mime === 'image/webp')       return 'webp';
  if (mime === 'image/jpeg')       return 'jpg';
  if (mime === 'image/png')        return 'png';
  if (mime === 'image/avif')       return 'avif';
  if (mime === 'image/gif')        return 'gif';
  if (mime === 'image/svg+xml')    return 'svg';
  if (mime === 'application/pdf')  return 'pdf';
  if (mime === 'video/webm')       return 'webm';
  if (mime === 'video/mp4')        return 'mp4';
  if (mime === 'audio/mpeg')       return 'mp3';
  if (mime === 'audio/mp4')        return 'm4a';  // AAC in MP4 container
  if (mime === 'audio/opus')       return 'opus';
  if (mime === 'audio/flac')       return 'flac';
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return 'wav';
  if (mime === 'audio/ogg')        return 'ogg';

  // Fallback: parse the human-readable format string (lower-cased).
  const fmt = result.format.toLowerCase();
  if (fmt.includes('webp'))  return 'webp';
  if (fmt.includes('jpeg') || fmt.includes('jpg')) return 'jpg';
  if (fmt.includes('png'))   return 'png';
  if (fmt.includes('avif'))  return 'avif';
  if (fmt.includes('pdf'))   return 'pdf';
  if (fmt.includes('webm'))  return 'webm';
  if (fmt.includes('mp4'))   return 'mp4';
  if (fmt.includes('mp3'))   return 'mp3';
  if (fmt.includes('aac'))   return 'm4a';
  if (fmt.includes('opus'))  return 'opus';
  if (fmt.includes('flac'))  return 'flac';
  if (fmt.includes('wav'))   return 'wav';
  if (fmt.includes('ogg'))   return 'ogg';
  if (fmt.includes('gif'))   return 'gif';
  if (fmt.includes('svg'))   return 'svg';
  return 'bin';
}
