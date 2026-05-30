import { uid, getOutputExtension } from '../lib/types';
import type { FileEntry, CompressOptions, VideoCodec } from '../lib/types';
import { compressVideo } from '../lib/compressVideo';
import { createDropZone, renderFileCard, patchFileCard, renderBatchBar } from '../components';
import { ffHasMT } from '../lib/ffmpeg';
import { toast } from '../toast';

export function mountVideo(root: HTMLElement) {
  let files: FileEntry[] = [];
  let mode: 'crf' | 'bitrate' | 'targetSize' = 'crf';
  let crfQuality = 75;
  let bitrate = 2000;
  let targetSizeMB = 0;
  let codec: VideoCodec = 'h264';
  let preset: 'ultrafast'|'fast'|'medium'|'slow' = 'fast';
  let maxWidth = 0;
  let fps = 0;

  function buildOptions(): CompressOptions {
    const o: CompressOptions = { videoCodec: codec, videoPreset: preset };
    if (mode === 'crf')        o.quality       = crfQuality / 100;
    if (mode === 'bitrate')    o.videoBitrate   = bitrate * 1000;
    if (mode === 'targetSize') o.targetSizeKB   = targetSizeMB * 1024;
    if (maxWidth > 0)          o.maxWidth       = maxWidth;
    if (fps > 0)               o.fps            = fps;
    return o;
  }

  function addFiles(fs: File[]) {
    const valid = fs.filter(f => f.type.startsWith('video/') || /\.(mp4|webm|mov|avi|mkv|m4v|flv|wmv|ogv|3gp)$/i.test(f.name));
    if (!valid.length) { toast('No video files found', 'error'); return; }
    files = [...files, ...valid.map(f => ({
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
    renderBatchBar(batchEl, files, compressAll, downloadAll, clearAll);
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

  function compressAll() { files.forEach(f => { if (f.status === 'idle' || f.status === 'error') compressEntry(f); }); }
  function downloadAll()  { files.filter(f => f.status === 'done').forEach(downloadEntry); }
  function clearAll()     { files = []; render(); }
  const cbs = { onCompress: compressEntry, onDownload: downloadEntry, onRemove: (id: string) => { files = files.filter(f => f.id !== id); render(); } };

  let batchEl!: HTMLElement; let listEl!: HTMLElement; let dzWrap!: ReturnType<typeof createDropZone>;

  root.innerHTML = `
    <div class="compress-wrap">
      <span class="back-link" data-nav="compress">← All formats</span>
      <div class="page-header">
        <div class="header-top">
          <span class="badge video">🎬 Video</span>
          <h1 class="page-title">Video Compressor</h1>
        </div>
        <p class="page-desc">FFmpeg.wasm (WASM${ffHasMT() ? ' MT' : ''}) · WebCodecs GPU · MediaRecorder — auto-selected per browser</p>
        <div class="caps-row">
          <span class="cap browser">${navigator.userAgent.includes('Chrome') ? 'Chrome' : navigator.userAgent.includes('Firefox') ? 'Firefox' : 'Safari'}</span>
          <span class="cap primary">FFmpeg.wasm</span>
          ${typeof VideoEncoder !== 'undefined' ? '<span class="cap gpu">WebCodecs</span>' : ''}
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
    const crf  = Math.round(18 + (1 - crfQuality / 100) * 17);
    card.innerHTML = `
      <div class="row">
        <div class="field">
          <span class="label">Mode</span>
          <div class="seg">
            <button class="${mode==='crf'?'on':''}" id="m-crf">Quality (CRF)</button>
            <button class="${mode==='bitrate'?'on':''}" id="m-br">Bitrate</button>
            <button class="${mode==='targetSize'?'on':''}" id="m-ts">Target size</button>
          </div>
        </div>
        ${mode==='crf'?`<div class="field"><span class="label">Quality <strong id="crf-lbl">${crfQuality}%</strong> <em>CRF ${crf}</em></span><input type="range" class="slider" min="1" max="99" value="${crfQuality}" id="crf-range"></div>`:''}
        ${mode==='bitrate'?`<div class="field"><span class="label">Bitrate (kbps)</span><input class="ti" type="number" value="${bitrate}" id="br-input"></div>`:''}
        ${mode==='targetSize'?`<div class="field"><span class="label">Target size (MB)</span><input class="ti" type="number" value="${targetSizeMB||''}" step="0.1" id="ts-input"></div>`:''}
        <div class="field">
          <span class="label">Codec</span>
          <select class="si" id="codec-sel">
            <option value="h264" ${codec==='h264'?'selected':''}>H.264 (MP4)</option>
            <option value="h265" ${codec==='h265'?'selected':''}>H.265 (HEVC)</option>
            <option value="vp9"  ${codec==='vp9'?'selected':''}>VP9 (WebM)</option>
            <option value="vp8"  ${codec==='vp8'?'selected':''}>VP8 (WebM)</option>
            <option value="av1"  ${codec==='av1'?'selected':''}>AV1</option>
          </select>
        </div>
        <div class="field">
          <span class="label">Preset</span>
          <select class="si" id="preset-sel">
            ${['ultrafast','fast','medium','slow'].map(p=>`<option value="${p}" ${preset===p?'selected':''}>${p}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <span class="label">Max width</span>
          <select class="si" id="maxw-sel">
            <option value="0" ${maxWidth===0?'selected':''}>Original</option>
            ${[3840,1920,1280,854,640].map(w=>`<option value="${w}" ${maxWidth===w?'selected':''}>${w}px</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <span class="label">FPS</span>
          <select class="si" id="fps-sel">
            <option value="0" ${fps===0?'selected':''}>Original</option>
            ${[60,30,25,24,15].map(f=>`<option value="${f}" ${fps===f?'selected':''}>${f}</option>`).join('')}
          </select>
        </div>
      </div>`;
    card.querySelector('#m-crf')?.addEventListener('click',    () => { mode='crf'; renderSettings(); });
    card.querySelector('#m-br')?.addEventListener('click',     () => { mode='bitrate'; renderSettings(); });
    card.querySelector('#m-ts')?.addEventListener('click',     () => { mode='targetSize'; renderSettings(); });
    card.querySelector('#crf-range')?.addEventListener('input', e => { crfQuality=+(e.target as HTMLInputElement).value; const c=Math.round(18+(1-crfQuality/100)*17); card.querySelector('#crf-lbl')!.innerHTML=`${crfQuality}% <em>CRF ${c}</em>`; });
    card.querySelector('#br-input')?.addEventListener('change', e => { bitrate=+(e.target as HTMLInputElement).value||2000; });
    card.querySelector('#ts-input')?.addEventListener('change', e => { targetSizeMB=+(e.target as HTMLInputElement).value||0; });
    card.querySelector('#codec-sel')?.addEventListener('change', e => { codec=(e.target as HTMLSelectElement).value as VideoCodec; });
    card.querySelector('#preset-sel')?.addEventListener('change', e => { preset=(e.target as HTMLSelectElement).value as typeof preset; });
    card.querySelector('#maxw-sel')?.addEventListener('change',  e => { maxWidth=+(e.target as HTMLSelectElement).value; });
    card.querySelector('#fps-sel')?.addEventListener('change',   e => { fps=+(e.target as HTMLSelectElement).value; });
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
