import { uid } from '../lib/types';
import type { FileEntry, CompressOptions, PdfLevel } from '../lib/types';
import { compressPdf } from '../lib/compressPdf';
import { createDropZone, renderFileCard, patchFileCard, renderBatchBar } from '../components';
import { toast } from '../toast';

export function mountPdf(root: HTMLElement) {
  let files: FileEntry[]  = [];
  let level: PdfLevel     = 'recommended';
  // Target size: 0 = auto (preset-driven), >0 = compress to this exact size
  let targetSize   = 0;       // in KB internally
  let targetUnit: 'MB' | 'KB' = 'MB';
  let targetInput  = '';      // raw user input string

  function resolveTargetKB(): number {
    const v = parseFloat(targetInput);
    if (!targetInput || isNaN(v) || v <= 0) return 0;
    return targetUnit === 'MB' ? Math.round(v * 1024) : Math.round(v);
  }

  function buildOptions(): CompressOptions {
    const o: CompressOptions = { pdfCompressionLevel: level };
    const kb = resolveTargetKB();
    if (kb > 0) o.targetSizeKB = kb;
    return o;
  }

  function addFiles(fs: File[]) {
    const valid = fs.filter(f =>
      f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (!valid.length) { toast('No PDF files found', 'error'); return; }
    files = [...files, ...valid.map(f => ({
      id: uid(), file: f, type: 'pdf' as const,
      status: 'idle' as const, progress: 0, options: buildOptions(),
    }))];
    render();
  }

  async function compressEntry(entry: FileEntry) {
    entry.status = 'compressing'; entry.progress = 0; entry.options = buildOptions();
    patchFileCard(entry, cbs);
    try {
      entry.result = await compressPdf(entry.file, entry.options, p => {
        entry.progress = p; patchFileCard(entry, cbs);
      });
      entry.status = 'done';
    } catch (e: any) {
      entry.error = e.message ?? 'PDF compression failed';
      entry.status = 'error';
      toast(entry.error!, 'error');
    }
    patchFileCard(entry, cbs);
    renderBatchBar(batchEl, files, compressAll, downloadAll, clearAll);
  }

  function downloadEntry(entry: FileEntry) {
    if (!entry.result) return;
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(entry.result.blob),
      download: entry.file.name.replace(/\.pdf$/i, '') + '_compressed.pdf',
    });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  function compressAll() { files.forEach(f => { if (f.status === 'idle' || f.status === 'error') compressEntry(f); }); }
  function downloadAll()  { files.filter(f => f.status === 'done').forEach(downloadEntry); }
  function clearAll()     { files = []; render(); }
  const cbs = {
    onCompress: compressEntry,
    onDownload: downloadEntry,
    onRemove:   (id: string) => { files = files.filter(f => f.id !== id); render(); },
  };

  let batchEl!: HTMLElement;
  let listEl!:  HTMLElement;
  let dzWrap!:  ReturnType<typeof createDropZone>;

  root.innerHTML = `
    <div class="tool-wrap">
      <span class="back-link" data-nav="">← Home</span>
      <div class="page-header">
        <div class="header-top">
          <span class="badge pdf">📄 PDF</span>
          <h1 class="page-title">PDF Compressor</h1>
        </div>
        <p class="page-sub">
          Structural mode resamples embedded images in-place — text and vectors stay sharp.
          Canvas fallback for extreme compression or encrypted PDFs.
        </p>
      </div>

      <div class="settings-card">
        <!-- Preset row -->
        <div class="s-row" style="margin-bottom:.9rem">
          <div class="s-field" style="flex:1">
            <span class="s-label">Compression level</span>
            <div class="pdf-presets" id="pdf-presets"></div>
          </div>
        </div>

        <!-- Target size row -->
        <div class="s-row">
          <div class="s-field" style="flex:1">
            <span class="s-label">Target output size
              <em id="ts-hint"> — optional, overrides preset quality</em>
            </span>
            <div class="target-size-row">
              <input class="ti" type="number" id="ts-input"
                placeholder="e.g. 2" min="0" step="any"
                style="width:100px"
                value="${targetInput}">
              <div class="ts-unit-toggle">
                <button class="${targetUnit==='MB'?'on':''}" id="ts-mb">MB</button>
                <button class="${targetUnit==='KB'?'on':''}" id="ts-kb">KB</button>
              </div>
              <span id="ts-warning" style="font-size:.72rem;color:var(--amber);display:none">
                ⚠ Target may not be reachable for some PDFs
              </span>
            </div>
            <div id="ts-detail" style="font-size:.72rem;color:var(--text-4);margin-top:.3rem"></div>
          </div>
        </div>
      </div>

      <div id="dz-mount"></div>
      <div class="batch-bar" id="batch-bar" style="display:none"></div>
      <div class="file-list" id="file-list"></div>
    </div>
  `;

  batchEl = root.querySelector('#batch-bar')!;
  listEl  = root.querySelector('#file-list')!;
  dzWrap  = createDropZone({
    accept:   'application/pdf,.pdf',
    icon:     '📄',
    title:    'Drop PDF files here',
    subtitle: 'One or multiple PDFs — files stay in your browser',
    onFiles:  addFiles,
  });
  root.querySelector('#dz-mount')!.appendChild(dzWrap);

  // Target size events
  root.querySelector('#ts-input')!.addEventListener('input', e => {
    targetInput = (e.target as HTMLInputElement).value;
    updateTsDetail();
  });
  root.querySelector('#ts-mb')!.addEventListener('click', () => {
    targetUnit = 'MB'; renderUnitToggle(); updateTsDetail();
  });
  root.querySelector('#ts-kb')!.addEventListener('click', () => {
    targetUnit = 'KB'; renderUnitToggle(); updateTsDetail();
  });

  function renderUnitToggle() {
    (root.querySelector('#ts-mb') as HTMLButtonElement).classList.toggle('on', targetUnit === 'MB');
    (root.querySelector('#ts-kb') as HTMLButtonElement).classList.toggle('on', targetUnit === 'KB');
  }

  function updateTsDetail() {
    const detail  = root.querySelector('#ts-detail') as HTMLElement;
    const warning = root.querySelector('#ts-warning') as HTMLElement;
    const kb = resolveTargetKB();
    if (kb <= 0) {
      detail.textContent  = 'Using preset quality — no size target.';
      warning.style.display = 'none';
      return;
    }
    const mb = (kb / 1024).toFixed(2);
    detail.textContent = `Binary-searching quality to hit ≈ ${kb} KB (${mb} MB) per file.`;
    // Warn if target seems very aggressive
    warning.style.display = kb < 50 ? 'inline' : 'none';
  }

  const PRESETS: { id: PdfLevel; emoji: string; label: string; sub: string }[] = [
    { id: 'low',         emoji: '🟢', label: 'Low',         sub: 'High quality · 220 DPI' },
    { id: 'recommended', emoji: '🔵', label: 'Recommended', sub: 'Balanced · 150 DPI' },
    { id: 'extreme',     emoji: '🟠', label: 'Extreme',     sub: 'Max saving · 96 DPI' },
  ];

  function renderPresets() {
    const container = root.querySelector('#pdf-presets')!;
    container.innerHTML = '';
    PRESETS.forEach(p => {
      const el = document.createElement('div');
      el.className = 'pdf-preset' + (level === p.id ? ' on' : '');
      el.innerHTML = `<div class="pp-emoji">${p.emoji}</div><div class="pp-label">${p.label}</div><div class="pp-sub">${p.sub}</div>`;
      el.addEventListener('click', () => { level = p.id; renderPresets(); });
      container.appendChild(el);
    });
  }

  function render() {
    renderPresets();
    updateTsDetail();
    (dzWrap as any).setHasFiles(files.length > 0);
    renderBatchBar(batchEl, files, compressAll, downloadAll, clearAll);
    listEl.innerHTML = '';
    files.forEach(f => listEl.appendChild(renderFileCard(f, cbs)));
  }

  render();
}
