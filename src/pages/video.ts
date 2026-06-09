import { registerBusyCheck } from '../main';
import { uid, getOutputExtension } from '../lib/types';
import type { FileEntry, CompressOptions, VideoCodec } from '../lib/types';
import { compressVideo } from '../lib/compressVideo';
import { createDropZone, renderFileCard, patchFileCard, renderBatchBar } from '../components';
import { ffHasMT } from '../lib/ffmpeg';
import { toast } from '../toast';
import { videoStore } from '../store';

export function mountVideo(root: HTMLElement) {
  // ── State — persisted in videoStore across navigations ──────
  const s = videoStore;

  function buildOptions(): CompressOptions {
    const o: CompressOptions = { videoCodec: s.codec, videoPreset: s.preset };
    if (s.mode === 'crf')        o.quality     = s.crfQuality / 100;
    if (s.mode === 'bitrate')    o.videoBitrate = s.bitrate * 1000;
    if (s.mode === 'targetSize') o.targetSizeKB = s.targetSizeMB * 1024;
    if (s.maxWidth > 0)          o.maxWidth     = s.maxWidth;
    if (s.fps > 0)               o.fps          = s.fps;
    return o;
  }

  function addFiles(fs: File[]) {
    const valid = fs.filter(f => f.type.startsWith('video/') || /\.(mp4|webm|mov|avi|mkv|m4v|flv|wmv|ogv|3gp)$/i.test(f.name));
    if (!valid.length) { toast('No video files found', 'error'); return; }
    s.files = [...s.files, ...valid.map(f => ({
      id: uid(), file: f, type: 'video' as const,
      status: 'idle' as const, progress: 0, options: buildOptions(),
    }))];
    render();
  }

  async function compressEntry(entry: FileEntry) {
    entry.status = 'compressing'; entry.progress = 0; entry.options = buildOptions();
    patchFileCard(entry, cbs);
    try {
      entry.result = await compressVideo(entry.file, entry.options, p => {
        entry.progress = p; patchFileCard(entry, cbs);
      });
      entry.status = 'done';
    } catch (e: any) {
      entry.error = e.message ?? 'Video compression failed';
      entry.status = 'error';
      toast(entry.error!, 'error');
    }
    patchFileCard(entry, cbs);
    renderBatchBar(batchEl, s.files, compressAll, downloadAll, clearAll);
  }

  function downloadEntry(entry: FileEntry) {
    if (!entry.result) return;
    const ext = getOutputExtension(entry.result);
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(entry.result.blob),
      download: entry.file.name.replace(/\.[^.]+$/, '') + '_compressed.' + ext,
    });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  function compressAll() { s.files.forEach(f => { if (f.status === 'idle' || f.status === 'error') compressEntry(f); }); }
  function downloadAll()  { s.files.filter(f => f.status === 'done').forEach(downloadEntry); }
  function clearAll()     { s.files = []; render(); }
  const cbs = { onCompress: compressEntry, onDownload: downloadEntry, onRemove: (id: string) => { s.files = s.files.filter(f => f.id !== id); render(); } };

  let batchEl!: HTMLElement; let listEl!: HTMLElement; let dzWrap!: ReturnType<typeof createDropZone>;

  root.innerHTML = `
    <div class="tool-wrap">
      <span class="back-link" data-nav="">← Home</span>
      <div class="page-header">
        <div class="header-top">
          <span class="badge video">🎬 Video</span>
          <h1 class="page-title">Video Compressor</h1>
        </div>
        <p class="page-desc">FFmpeg.wasm (WASM${ffHasMT() ? ' MT' : ''}) · MediaRecorder — auto-selected per browser</p>
        <div class="caps-row">
          <span class="cap browser">${navigator.userAgent.includes('Chrome') ? 'Chrome' : navigator.userAgent.includes('Firefox') ? 'Firefox' : 'Safari'}</span>
          <span class="cap primary">FFmpeg.wasm</span>
          <span class="cap">MediaRecorder</span>
          ${ffHasMT() ? '<span class="cap">SharedArrayBuffer ✓</span>' : '<span class="cap">No COOP (ST mode)</span>'}
        </div>
      </div>
      <div class="settings-card" id="video-settings"></div>
      <div id="dz-mount"></div>
      <div class="batch-bar" id="batch-bar" style="display:none"></div>
      <div class="file-list" id="file-list"></div>
    </div>
  `;

  batchEl = root.querySelector('#batch-bar')!;
  listEl  = root.querySelector('#file-list')!;
  dzWrap  = createDropZone({ accept: 'video/*', icon: '🎬', title: 'Drop video files here', subtitle: 'MP4 · WebM · MOV · AVI · MKV', onFiles: addFiles });
  root.querySelector('#dz-mount')!.appendChild(dzWrap);

  function renderSettings() {
    const card = root.querySelector('#video-settings')!;
    const crf  = Math.round(18 + (1 - s.crfQuality / 100) * 17);
    card.innerHTML = `
      <div class="s-row">
        <div class="s-field">
          <span class="s-label">Mode</span>
          <div class="seg" role="group" aria-label="Compression mode">
            <button class="${s.mode==='crf'?'on':''}" aria-pressed="${s.mode==='crf'?'true':'false'}" id="m-crf">Quality (CRF)</button>
            <button class="${s.mode==='bitrate'?'on':''}" aria-pressed="${s.mode==='bitrate'?'true':'false'}" id="m-br">Bitrate</button>
            <button class="${s.mode==='targetSize'?'on':''}" aria-pressed="${s.mode==='targetSize'?'true':'false'}" id="m-ts">Target size</button>
          </div>
        </div>
        ${s.mode==='crf'?`<div class="s-field"><span class="s-label">Quality <strong id="crf-lbl">${s.crfQuality}%</strong> <em>CRF ${crf}</em></span><input type="range" class="slider" min="1" max="99" value="${s.crfQuality}" id="crf-range"></div>`:''}
        ${s.mode==='bitrate'?`<div class="s-field"><span class="s-label">Bitrate (kbps)</span><input class="ti" type="number" value="${s.bitrate}" id="br-input"></div>`:''}
        ${s.mode==='targetSize'?`<div class="s-field"><span class="s-label">Target size (MB)</span><input class="ti" type="number" value="${s.targetSizeMB||''}" step="0.1" id="ts-input"></div>`:''}
        <div class="s-field">
          <span class="s-label">Codec</span>
          <select class="si" id="codec-sel">
            <option value="h264" ${s.codec==='h264'?'selected':''}>H.264 (MP4)</option>
            <option value="h265" ${s.codec==='h265'?'selected':''}>H.265 (HEVC)</option>
            <option value="vp9"  ${s.codec==='vp9'?'selected':''}>VP9 (WebM)</option>
            <option value="vp8"  ${s.codec==='vp8'?'selected':''}>VP8 (WebM)</option>
            <option value="av1"  ${s.codec==='av1'?'selected':''}>AV1</option>
          </select>
        </div>
        <div class="s-field">
          <span class="s-label">Preset</span>
          <select class="si" id="preset-sel">
            ${['ultrafast','fast','medium','slow'].map(p=>`<option value="${p}" ${s.preset===p?'selected':''}>${p}</option>`).join('')}
          </select>
        </div>
        <div class="s-field">
          <span class="s-label">Max width</span>
          <select class="si" id="maxw-sel">
            <option value="0" ${s.maxWidth===0?'selected':''}>Original</option>
            ${[3840,1920,1280,854,640].map(w=>`<option value="${w}" ${s.maxWidth===w?'selected':''}>${w}px</option>`).join('')}
          </select>
        </div>
        <div class="s-field">
          <span class="s-label">FPS</span>
          <select class="si" id="fps-sel">
            <option value="0" ${s.fps===0?'selected':''}>Original</option>
            ${[60,30,25,24,15].map(f=>`<option value="${f}" ${s.fps===f?'selected':''}>${f}</option>`).join('')}
          </select>
        </div>
      </div>`;
    card.querySelector('#m-crf')?.addEventListener('click',    () => { s.mode='crf'; renderSettings(); });
    card.querySelector('#m-br')?.addEventListener('click',     () => { s.mode='bitrate'; renderSettings(); });
    card.querySelector('#m-ts')?.addEventListener('click',     () => { s.mode='targetSize'; renderSettings(); });
    card.querySelector('#crf-range')?.addEventListener('input', e => { s.crfQuality=+(e.target as HTMLInputElement).value; const c=Math.round(18+(1-s.crfQuality/100)*17); card.querySelector('#crf-lbl')!.innerHTML=`${s.crfQuality}% <em>CRF ${c}</em>`; });
    card.querySelector('#br-input')?.addEventListener('change', e => { s.bitrate=+(e.target as HTMLInputElement).value||2000; });
    card.querySelector('#ts-input')?.addEventListener('change', e => { s.targetSizeMB=+(e.target as HTMLInputElement).value||0; });
    card.querySelector('#codec-sel')?.addEventListener('change', e => { s.codec=(e.target as HTMLSelectElement).value as VideoCodec; });
    card.querySelector('#preset-sel')?.addEventListener('change', e => { s.preset=(e.target as HTMLSelectElement).value as typeof s.preset; });
    card.querySelector('#maxw-sel')?.addEventListener('change',  e => { s.maxWidth=+(e.target as HTMLSelectElement).value; });
    card.querySelector('#fps-sel')?.addEventListener('change',   e => { s.fps=+(e.target as HTMLSelectElement).value; });
  }

  function render() {
    registerBusyCheck(() => s.files.some(f => f.status === 'compressing'));
    renderSettings();
    (dzWrap as any).setHasFiles(s.files.length > 0);
    renderBatchBar(batchEl, s.files, compressAll, downloadAll, clearAll);
    listEl.innerHTML = '';
    s.files.forEach(f => listEl.appendChild(renderFileCard(f, cbs)));
  }

  render();
}
