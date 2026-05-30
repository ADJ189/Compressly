import type { CompressResult } from './types';

export async function optimizeSvg(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<CompressResult> {
  onProgress?.(5);
  let svg = await file.text();
  onProgress?.(15);

  // Remove XML declaration
  svg = svg.replace(/<\?xml[^?]*\?>/gi, '');

  // Remove comments
  let prev: string;
  do { prev = svg; svg = svg.replace(/<!--[\s\S]*?-->/g, ''); } while (svg !== prev);

  // Remove metadata, editor namespaces
  svg = svg.replace(/<metadata[\s\S]*?<\/metadata>/gi, '');
  svg = svg.replace(/<sodipodi:[^/]*(\/>|[\s\S]*?<\/sodipodi:[^>]*>)/gi, '');
  svg = svg.replace(/<inkscape:[^/]*(\/>|[\s\S]*?<\/inkscape:[^>]*>)/gi, '');
  svg = svg.replace(/\s+xmlns:(inkscape|sodipodi|sketch|dc|cc|rdf|xlink)="[^"]*"/gi, '');
  svg = svg.replace(/\s+(inkscape|sodipodi):[a-z-]+="[^"]*"/gi, '');
  onProgress?.(35);

  // Remove empty groups and defs
  svg = svg.replace(/<g[^>]*>\s*<\/g>/gi, '');
  svg = svg.replace(/<g\s*\/>/gi, '');
  svg = svg.replace(/<defs>\s*<\/defs>/gi, '');

  // Round long decimals (≥3 decimal places → 2)
  svg = svg.replace(/(\d+\.\d{3,})/g, m =>
    parseFloat(m).toFixed(2).replace(/\.?0+$/, ''));
  onProgress?.(55);

  // Compact path data
  svg = svg.replace(/\s+([MmZzLlHhVvCcSsQqTtAa])/g, '$1');
  svg = svg.replace(/([MmZzLlHhVvCcSsQqTtAa])\s+/g, '$1');
  svg = svg.replace(/,\s+/g, ',');

  // Strip embedded scripts (security)
  do {
    prev = svg;
    svg  = svg.replace(/<script\b[^>]*(?:\/>|>[\s\S]*?<\/script(?:\s[^>]*)?>)/gi, '');
  } while (svg !== prev);

  // Remove hidden elements
  do {
    prev = svg;
    svg = svg.replace(/<[^>]+(?:display\s*:\s*none|visibility\s*:\s*hidden)[^>]*(\/>|[\s\S]*?<\/[a-z]+>)/gi, '');
  } while (svg !== prev);

  // Re-strip embedded scripts in case hidden-element removal exposes new tags
  do {
    prev = svg;
    svg  = svg.replace(/<script\b[^>]*(?:\/>|>[\s\S]*?<\/script(?:\s[^>]*)?>)/gi, '');
  } while (svg !== prev);

  // Collapse whitespace
  svg = svg.replace(/>\s{2,}</g, '><');
  svg = svg.replace(/\s{2,}/g, ' ').trim();
  onProgress?.(80);

  // Add viewBox if missing
  if (!svg.includes('viewBox') && svg.includes('width=') && svg.includes('height=')) {
    const w = svg.match(/width="([^"]+)"/)?.[1];
    const h = svg.match(/height="([^"]+)"/)?.[1];
    if (w && h && !isNaN(parseFloat(w)) && !isNaN(parseFloat(h)))
      svg = svg.replace('<svg', `<svg viewBox="0 0 ${w} ${h}"`);
  }

  onProgress?.(100);
  const blob = new Blob([svg], { type: 'image/svg+xml' });

  return {
    blob,
    originalSize:     file.size,
    compressedSize:   blob.size,
    compressionRatio: file.size / blob.size,
    format:           'SVG (optimised · pure TS)',
  };
}
