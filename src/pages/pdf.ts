import { uid, getOutputExtension } from '../lib/types';
import type { FileEntry, CompressOptions, PdfLevel } from '../lib/types';
import { compressPdf } from '../lib/compressPdf';
import { createDropZone, renderFileCard, patchFileCard, renderBatchBar } from '../components';
import { toast } from '../toast';

export function mountPdf(root: HTMLElement) {
  let files: FileEntry[] = [];
  let level: PdfLevel = 'recommended';
  let targetSizeMB = 0;

  function buildOptions(): CompressOptions {
    const o: CompressOptions = { pdfCompressionLevel: level };
    if (targetSizeMB > 0) o.targetSizeKB = targetSizeMB * 1024;
    return o;
  }

  function addFiles(fs: File[]) {
    const valid = fs.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
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
  const cbs = { onCompress: compressEntry, onDownload: downloadEntry, onRemove: (id: string) => { files = files.filter(f => f.id !== id); render(); } };

  let batchEl!: HTMLElement;
  let listEl!: HTMLElement;
  let dzWrap!: ReturnType<typeof createDropZone>;

  root.innerHTML = `
    <div class="compress-wrap">
      <span class="back-link" data-nav="compress">← All formats</span>
      <div class="page-header">
        <div class="header-top">
          <span class="badge pdf">📄 PDF</span>
          <h1 class="page-title">PDF Compressor</h1>
        </div>
        <p class="page-desc">PDF.js renders each page → re-embedded as JPEG via pdf-lib. Reduces file size dramatically while keeping text readable.</p>
      </div>
      <div class="settings-card">
        <div class="row">
          <div class="field" style="flex:1">
            <span class="label">Compression level</span>
            <div class="pdf-presets" id="pdf-presets"></div>
          </div>
          <div class="field">
            <span class="label">Target size (MB, optional)</span>
            <input class="ti" type="number" id="target-mb" value="${targetSizeMB||''}" min="0" step="0.1" placeholder="0 = auto">
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
  dzWrap  = createDropZone({ accept: 'application/pdf,.pdf', icon: '📄', title: 'Drop PDF files here', subtitle: 'One or multiple PDFs', onFiles: addFiles });
  root.querySelector('#dz-mount')!.appendChild(dzWrap);
  root.querySelector('#target-mb')!.addEventListener('change', e => { targetSizeMB = +(e.target as HTMLInputElement).value || 0; });

  const presets: { id: PdfLevel; emoji: string; label: string; sub: string }[] = [
    { id: 'low',          emoji: '🟢', label: 'Low',         sub: 'High quality' },
    { id: 'recommended',  emoji: '🔵', label: 'Recommended', sub: 'Best balance' },
    { id: 'extreme',      emoji: '🟠', label: 'Extreme',     sub: 'Max saving' },
  ];

  function renderPresets() {
    const container = root.querySelector('#pdf-presets')!;
    container.innerHTML = '';
    presets.forEach(p => {
      const el = document.createElement('div');
      el.className = 'pdf-preset' + (level === p.id ? ' on' : '');
      el.innerHTML = `<div class="pp-emoji">${p.emoji}</div><div class="pp-label">${p.label}</div><div class="pp-sub">${p.sub}</div>`;
      el.addEventListener('click', () => { level = p.id; renderPresets(); });
      container.appendChild(el);
    });
  }

  function render() {
    renderPresets();
    (dzWrap as any).setHasFiles(files.length > 0);
    renderBatchBar(batchEl, files, compressAll, downloadAll, clearAll);
    listEl.innerHTML = '';
    files.forEach(f => listEl.appendChild(renderFileCard(f, cbs)));
  }

  render();
}
