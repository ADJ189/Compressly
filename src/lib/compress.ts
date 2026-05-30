import type { FileEntry, CompressResult } from './types';
import { compressImage } from './compressImage';
import { compressPdf }   from './compressPdf';
import { compressVideo } from './compressVideo';
import { compressAudio } from './compressAudio';
import { compressGif }   from './compressGif';
import { optimizeSvg }   from './optimizeSvg';

export async function compress(
  entry: FileEntry,
  onProgress?: (pct: number) => void,
): Promise<CompressResult> {
  const { file, type, options } = entry;
  switch (type) {
    case 'image': return compressImage(file, options, onProgress);
    case 'pdf':   return compressPdf(file, options, onProgress);
    case 'video': return compressVideo(file, options, onProgress);
    case 'audio': return compressAudio(file, options, onProgress);
    case 'gif':   return compressGif(file, options, onProgress);
    case 'svg':   return optimizeSvg(file, onProgress);
    default:      throw new Error(`Unsupported file type: ${type}`);
  }
}
