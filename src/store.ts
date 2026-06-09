/**
 * store.ts — Central state store for CompressZ.
 *
 * Each tool module stores its file queue and settings here instead of in local
 * mount-function variables. Because this module is loaded once and never
 * re-executed, state survives the router destroying and recreating page DOM.
 *
 * Pattern:
 *   import { imageStore } from '../store';
 *   // read:  imageStore.files
 *   // write: imageStore.files = [...imageStore.files, newEntry];
 */

import type { FileEntry, ImageFormat, AudioFormat, VideoCodec, PdfLevel } from './lib/types';

// ── Images ────────────────────────────────────────────────────
export interface ImageState {
  files:        FileEntry[];
  mode:         'quality' | 'targetSize';
  quality:      number;
  targetSizeKB: number;
  format:       ImageFormat;
  maxDim:       number;
}
export const imageStore: ImageState = {
  files:        [],
  mode:         'quality',
  quality:      82,
  targetSizeKB: 200,
  format:       'image/webp',
  maxDim:       0,
};

// ── Audio ─────────────────────────────────────────────────────
export interface AudioState {
  files:      FileEntry[];
  fmt:        AudioFormat;
  bitrate:    number;
  sampleRate: number;
  stripMeta:  boolean;
}
export const audioStore: AudioState = {
  files:      [],
  fmt:        'mp3',
  bitrate:    192,
  sampleRate: 0,
  stripMeta:  true,
};

// ── Video ─────────────────────────────────────────────────────
export interface VideoState {
  files:        FileEntry[];
  mode:         'crf' | 'bitrate' | 'targetSize';
  crfQuality:   number;
  bitrate:      number;
  targetSizeMB: number;
  codec:        VideoCodec;
  preset:       'ultrafast' | 'fast' | 'medium' | 'slow';
  maxWidth:     number;
  fps:          number;
}
export const videoStore: VideoState = {
  files:        [],
  mode:         'crf',
  crfQuality:   75,
  bitrate:      2000,
  targetSizeMB: 0,
  codec:        'h264',
  preset:       'fast',
  maxWidth:     0,
  fps:          0,
};

// ── GIF ───────────────────────────────────────────────────────
export interface GifState {
  files:      FileEntry[];
  quality:    number;
  gifToVideo: boolean;
  maxWidth:   number;
  fps:        number;
}
export const gifStore: GifState = {
  files:      [],
  quality:    82,
  gifToVideo: false,
  maxWidth:   0,
  fps:        0,
};

// ── PDF ───────────────────────────────────────────────────────
export interface PdfState {
  files:       FileEntry[];
  level:       PdfLevel;
  targetUnit:  'MB' | 'KB';
  targetInput: string;
}
export const pdfStore: PdfState = {
  files:       [],
  level:       'recommended',
  targetUnit:  'MB',
  targetInput: '',
};
