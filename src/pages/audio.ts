import { registerBusyCheck } from '../main';
import { uid } from '../lib/types';
import type { FileEntry, CompressOptions, AudioFormat } from '../lib/types';
import { compressAudio } from '../lib/compressAudio';
import { createDropZone, renderFileCard, patchFileCard, renderBatchBar } from '../components';
import { toast } from '../toast';
import { audioStore } from '../store';

const BITRATE_OPTS: Record<AudioFormat, number[]> = {
  mp3:  [64, 96, 128, 192, 256, 320],
  aac:  [64, 96, 128, 160, 192, 256],
  ogg:  [64, 96, 128, 160, 192, 256],
  opus: [32, 48, 64,  96,  128, 192],
  flac: [],
  wav:  [],
};

export function mountAudio(root: HTMLElement) {
  // ── State — persisted in audioStore across navigations ──────
  const s = audioStore;

  const isLossless = (f: AudioFormat) => f === 'flac' || f === 'wav';

  function buildOptions(): CompressOptions {
    const o: CompressOptions = { audioFormat: s.fmt, stripMetadata: s.stripMeta };
    if (!isLossless(s.fmt)) o.audioBitrate = s.bitrate;
    if (s.sampleRate > 0)   o.audioSampleRate = s.sampleRate;
    return o;
  }

  function addFiles(fs: File[]) {
    const valid = fs.filter(f =>
      f.type.startsWith('audio/') || f.type.startsWith('video/') ||
      /\.(mp3|aac|ogg|opus|flac|wav|m4a|wma|aiff|aif|mp4|mkv|mov)$/i.test(f.name));
    if (!valid.length) { toast('No audio files found', 'error'); return; }
    s.files = [...s.files, ...valid.map(f => ({
      id: uid(), file: f, type: 'audio' as const,
      status: 'idle' as const, progress: 0, options: buildOptions(),
    }))];
    render();
  }

  async function compressEntry(entry: FileEntry) {
    entry.status = 'compressing'; entry.progress = 0; entry.options = buildOptions();
    patchFileCard(entry, cbs);
    try {
      entry.result = await compressAudio(entry.file, entry.options, p => {
        entry.progress = p; patchFileCard(entry, cbs);
      });
      entry.status = 'done';
    } catch (e: any) {
      entry.error = e.message ?? 'Audio compression failed';
      entry.status = 'error';
      toast(entry.error!, 'error');
    }
    patchFileCard(entry, cbs);
    renderBatchBar(batchEl, s.files, compressAll, downloadAll, clearAll);
  }

  function downloadEntry(entry: FileEntry) {
    if (!entry.result) return;
    const EXT_MAP: Record<AudioFormat, string> = { mp3:'mp3', aac:'m4a', ogg:'ogg', opus:'opus', flac:'flac', wav:'wav' };
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(entry.result.blob),
      download: entry.file.name.replace(/\.[^.]+$/, '') + '_compressed.' + EXT_MAP[s.fmt],
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
          <span class="badge audio">🎵 Audio</span>
          <h1 class="page-title">Audio Compressor</h1>
        </div>
        <p class="page-desc">FFmpeg.wasm · MP3 · AAC · OGG · Opus · FLAC · WAV · Also extracts audio from MP4/MKV/MOV</p>
      </div>
      <div class="settings-card" id="audio-settings"></div>
      <div id="dz-mount"></div>
      <div class="batch-bar" id="batch-bar" style="display:none"></div>
      <div class="file-list" id="file-list"></div>
    </div>
  `;

  batchEl = root.querySelector('#batch-bar')!;
  listEl  = root.querySelector('#file-list')!;
  dzWrap  = createDropZone({ accept: 'audio/*,video/mp4,video/x-matroska,.mp4,.mkv,.mov', icon: '🎵', title: 'Drop audio or video files here', subtitle: 'MP3 · AAC · OGG · Opus · FLAC · WAV + video for audio extraction', onFiles: addFiles });
  root.querySelector('#dz-mount')!.appendChild(dzWrap);

  function renderSettings() {
    const card = root.querySelector('#audio-settings')!;
    const formats: AudioFormat[] = ['mp3','aac','ogg','opus','flac','wav'];
    const bOpts  = BITRATE_OPTS[s.fmt];
    const ll     = isLossless(s.fmt);

    card.innerHTML = `
      <div class="s-row">
        <div class="s-field">
          <span class="s-label">Output format</span>
          <div class="fmt-pills" id="fmt-pills">
            ${formats.map(f=>`<button class="pill${s.fmt===f?' on':''}" data-fmt="${f}">${f.toUpperCase()}</button>`).join('')}
          </div>
        </div>
        ${!ll && bOpts.length ? `
          <div class="s-field">
            <span class="s-label">Bitrate</span>
            <select class="si" id="br-sel">
              ${bOpts.map(b=>`<option value="${b}" ${s.bitrate===b?'selected':''}>${b} kbps</option>`).join('')}
            </select>
          </div>` : ll ? `<div class="s-field"><span class="s-label" style="color:var(--green)">✓ Lossless — no bitrate setting</span></div>` : ''}
        <div class="s-field">
          <span class="s-label">Sample rate</span>
          <select class="si" id="sr-sel">
            <option value="0" ${s.sampleRate===0?'selected':''}>Source rate</option>
            ${[48000,44100,32000,22050].map(r=>`<option value="${r}" ${s.sampleRate===r?'selected':''}>${r/1000} kHz</option>`).join('')}
          </select>
        </div>
        <div class="s-field">
          <span class="s-label">Metadata</span>
          <div class="seg" role="group" aria-label="Metadata handling">
            <button class="${s.stripMeta?'on':''}" aria-pressed="${s.stripMeta?'true':'false'}" id="strip-on">Strip tags</button>
            <button class="${!s.stripMeta?'on':''}" aria-pressed="${!s.stripMeta?'true':'false'}" id="strip-off">Keep tags</button>
          </div>
        </div>
      </div>`;

    card.querySelectorAll('[data-fmt]').forEach(btn => btn.addEventListener('click', () => {
      s.fmt = (btn as HTMLElement).dataset.fmt as AudioFormat;
      s.bitrate = BITRATE_OPTS[s.fmt]?.[3] ?? 128;
      renderSettings();
    }));
    card.querySelector('#br-sel')?.addEventListener('change', e => { s.bitrate = +(e.target as HTMLSelectElement).value; });
    card.querySelector('#sr-sel')?.addEventListener('change', e => { s.sampleRate = +(e.target as HTMLSelectElement).value; });
    card.querySelector('#strip-on')?.addEventListener('click', ()  => { s.stripMeta = true; renderSettings(); });
    card.querySelector('#strip-off')?.addEventListener('click', () => { s.stripMeta = false; renderSettings(); });
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
