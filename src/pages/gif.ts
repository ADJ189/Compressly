import { uid } from '../lib/types';
import type { FileEntry, CompressOptions } from '../lib/types';
import { compressGif } from '../lib/compressGif';
import { createDropZone, renderFileCard, patchFileCard, renderBatchBar } from '../components';
import { toast } from '../toast';

export function mountGif(root: HTMLElement) {
  let files: FileEntry[] = [];
  let quality   = 82;
  let gifToVideo = false;
  let maxWidth   = 0;
  let fps        = 0;

  function buildOptions(): CompressOptions {
    return { quality: quality / 100, gifToVideo, maxWidth: maxWidth || undefined, fps: fps || undefined };
  }

  function addFiles(fs: File[]) {
    const valid = fs.filter(f => f.type === 'image/gif' || f.name.toLowerCase().endsWith('.gif'));
    if (!valid.length) { toast('No GIF files found', 'error'); return; }
    files = [...files, ...valid.map(f => ({
      id: uid(), file: f, type: 'gif' as const,
      status: 'idle' as const, progress: 0, options: buildOptions(),
    }))];
    render();
  }

  async function compressEntry(entry: FileEntry) {
    entry.status = 'compressing'; entry.progress = 0; entry.options = buildOptions();
    patchFileCard(entry, cbs);
    try {
      entry.result = await compressGif(entry.file, entry.options, p => {
        entry.progress = p; patchFileCard(entry, cbs);
      });
      entry.status = 'done';
    } catch (e: any) {
      entry.error = e.message ?? 'GIF compression failed';
      entry.status = 'error';
      toast(entry.error!, 'error');
    }
    patchFileCard(entry, cbs);
    renderBatchBar(batchEl, files, compressAll, downloadAll, clearAll);
  }

  function downloadEntry(entry: FileEntry) {
    if (!entry.result) return;
    const ext = gifToVideo ? 'webm' : 'gif';
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(entry.result.blob),
      download: entry.file.name.replace('.gif', `_compressed.${ext}`),
    });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  function compressAll() { files.forEach(f => { if (f.status === 'idle' || f.status === 'error') compressEntry(f); }); }
  function downloadAll()  { files.filter(f => f.status === 'done').forEach(downloadEntry); }
  function clearAll()     { files = []; render(); }
  const cbs = { onCompress: compressEntry, onDownload: downloadEntry, onRemove: (id: string) => { files = files.filter(f => f.id !== id); render(); } };

  let batchEl!: HTMLElement; let listEl!: HTMLElement; let dzWrap!: ReturnType<typeof createDropZone>;

  root.innerHTML = `
    <div class="tool-wrap">
      <span class="back-link" data-nav="">← Home</span>
      <div class="page-header">
        <div class="header-top">
          <span class="badge gif">🎞️ GIF</span>
          <h1 class="page-title">GIF Optimiser</h1>
        </div>
        <p class="page-desc">Two-pass palettegen · paletteuse Bayer dithering · GIF-to-WebM VP9 conversion · FFmpeg.wasm</p>
      </div>
      <div class="settings-card" id="gif-settings"></div>
      <div id="dz-mount"></div>
      <div class="batch-bar" id="batch-bar" style="display:none"></div>
      <div class="file-list" id="file-list"></div>
    </div>
  `;

  batchEl = root.querySelector('#batch-bar')!;
  listEl  = root.querySelector('#file-list')!;
  dzWrap  = createDropZone({ accept: 'image/gif,.gif', icon: '🎞️', title: 'Drop GIF files here', subtitle: 'Animated or static GIFs', onFiles: addFiles });
  root.querySelector('#dz-mount')!.appendChild(dzWrap);

  function renderSettings() {
    const card = root.querySelector('#gif-settings')!;
    const colors = Math.round(16 + (quality / 100) * 240);
    card.innerHTML = `
      <div class="s-row">
        <div class="s-field">
          <span class="s-label">Output</span>
          <div class="seg">
            <button class="${!gifToVideo?'on':''}" id="out-gif">Optimised GIF</button>
            <button class="${gifToVideo?'on':''}" id="out-webm">Convert to WebM</button>
          </div>
        </div>
        ${!gifToVideo ? `
        <div class="s-field">
          <span class="s-label">Quality <strong id="ql">${quality}%</strong> <em>${colors} colours</em></span>
          <input type="range" class="slider" min="10" max="99" value="${quality}" id="q-range">
        </div>
        <div class="s-field">
          <span class="s-label">Max width</span>
          <select class="si" id="mw-sel">
            <option value="0"   ${maxWidth===0?'selected':''}>Original</option>
            <option value="800" ${maxWidth===800?'selected':''}>800 px</option>
            <option value="600" ${maxWidth===600?'selected':''}>600 px</option>
            <option value="480" ${maxWidth===480?'selected':''}>480 px</option>
            <option value="320" ${maxWidth===320?'selected':''}>320 px</option>
          </select>
        </div>
        <div class="s-field">
          <span class="s-label">FPS limit</span>
          <select class="si" id="fps-sel">
            <option value="0"  ${fps===0?'selected':''}>Original</option>
            <option value="24" ${fps===24?'selected':''}>24 fps</option>
            <option value="15" ${fps===15?'selected':''}>15 fps</option>
            <option value="10" ${fps===10?'selected':''}>10 fps</option>
          </select>
        </div>` : `<div class="s-field"><p style="font-size:.82rem;color:var(--text-3);line-height:1.6">Converts to WebM VP9 for 70–95% size reduction. <br>Great for websites that accept video.</p></div>`}
      </div>`;

    card.querySelector('#out-gif')?.addEventListener('click',   () => { gifToVideo=false; renderSettings(); });
    card.querySelector('#out-webm')?.addEventListener('click',  () => { gifToVideo=true; renderSettings(); });
    card.querySelector('#q-range')?.addEventListener('input', e => {
      quality = +(e.target as HTMLInputElement).value;
      const c = Math.round(16+(quality/100)*240);
      card.querySelector('#ql')!.innerHTML = `${quality}% <em>${c} colours</em>`;
    });
    card.querySelector('#mw-sel')?.addEventListener('change', e => { maxWidth=+(e.target as HTMLSelectElement).value; });
    card.querySelector('#fps-sel')?.addEventListener('change', e => { fps=+(e.target as HTMLSelectElement).value; });
  }

  function render() {
    renderSettings();
    (dzWrap as any).setHasFiles(files.length > 0);
    renderBatchBar(batchEl, files, compressAll, downloadAll, clearAll);
    listEl.innerHTML = '';
    files.forEach(f => listEl.appendChild(renderFileCard(f, cbs)));
  }

  render();
}
