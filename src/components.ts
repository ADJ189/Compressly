import { formatBytes } from './lib/types';
import type { FileEntry, CompressResult } from './lib/types';

// ── DropZone ──────────────────────────────────────────────────
export function createDropZone(opts: {
  accept:   string;
  icon:     string;
  title:    string;
  subtitle: string;
  onFiles:  (files: File[]) => void;
}): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'dz';

  function buildInner(hasFiles: boolean) {
    wrap.innerHTML = '';
    if (!hasFiles) {
      const inner = document.createElement('div');
      inner.className = 'dz-inner';
      inner.innerHTML = `
        <div class="dz-icon">${opts.icon}</div>
        <p class="dz-title">${opts.title}</p>
        <p class="dz-sub">${opts.subtitle}</p>
        <label class="dz-btn">Browse files<input type="file" accept="${opts.accept}" multiple style="display:none"></label>
      `;
      inner.querySelector('input')!.addEventListener('change', handleInput);
      wrap.appendChild(inner);
    } else {
      const lbl = document.createElement('label');
      lbl.className = 'dz-add';
      lbl.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Add more files<input type="file" accept="${opts.accept}" multiple style="display:none">`;
      lbl.querySelector('input')!.addEventListener('change', handleInput);
      wrap.appendChild(lbl);
    }
  }

  function handleInput(e: Event) {
    const el = e.target as HTMLInputElement;
    const files = Array.from(el.files ?? []).filter(f => f.size > 0);
    if (files.length) opts.onFiles(files);
    el.value = '';
  }

  wrap.addEventListener('dragover', e => { e.preventDefault(); wrap.classList.add('drag-active'); });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drag-active'));
  wrap.addEventListener('drop', e => {
    e.preventDefault(); wrap.classList.remove('drag-active');
    const files = Array.from(e.dataTransfer?.files ?? []).filter(f => f.size > 0);
    if (files.length) opts.onFiles(files);
  });

  buildInner(false);

  // Expose update method via property
  (wrap as any).setHasFiles = (v: boolean) => buildInner(v);
  return wrap;
}

// ── FileCard ──────────────────────────────────────────────────
export interface FileCardCallbacks {
  onCompress: (e: FileEntry) => void;
  onDownload: (e: FileEntry) => void;
  onRemove:   (id: string) => void;
}

const TYPE_ICON: Record<string, string> = {
  image: '🖼️', pdf: '📄', video: '🎬', audio: '🎵', gif: '🎞️', svg: '〽️',
};

export function renderFileCard(entry: FileEntry, cbs: FileCardCallbacks): HTMLElement {
  const el = document.createElement('div');
  el.className = 'file-card' + (
    entry.status === 'done'        ? ' is-done' :
    entry.status === 'error'       ? ' is-error' :
    entry.status === 'compressing' ? ' is-compressing' : ''
  );
  el.id = 'card-' + entry.id;

  const icon = TYPE_ICON[entry.type] ?? '📁';

  // meta line
  let metaHtml = `<span>${formatBytes(entry.file.size)}</span>`;
  if (entry.result) {
    const r    = entry.result;
    const pct  = ((1 - r.compressedSize / r.originalSize) * 100).toFixed(1);
    const bigger = r.compressionRatio < 1;
    metaHtml += `
      <span class="sep">→</span>
      <span class="comp">${formatBytes(r.compressedSize)}</span>
      <span class="${bigger ? 'bigger' : 'ratio'}">${bigger ? 'larger' : `−${pct}%`}</span>
      ${r.width ? `<span class="dim">${r.width}×${r.height}</span>` : ''}
      ${r.format ? `<span class="eng">${r.format.split('·')[1]?.trim() ?? ''}</span>` : ''}
    `;
  }
  if (entry.status === 'error') {
    metaHtml += `<span class="err-msg">⚠ ${entry.error?.slice(0, 70) ?? 'Error'}</span>`;
  }

  // progress
  const progressHtml = entry.status === 'compressing' ? `
    <div class="fc-progress"><div class="fc-progress-fill" style="width:${entry.progress}%"></div></div>
    <div class="fc-progress-label">${entry.progress < 6 ? 'Loading…' : `${entry.progress}%`}</div>
  ` : '';

  // actions
  let actHtml = '';
  if (entry.status === 'idle' || entry.status === 'error') {
    actHtml += `<button class="fc-btn primary" data-action="compress">${entry.status === 'error' ? 'Retry' : 'Compress'}</button>`;
  } else if (entry.status === 'compressing') {
    actHtml += `<span class="fc-pct">${entry.progress}%</span>`;
  } else if (entry.status === 'done') {
    actHtml += `<button class="fc-btn dl" data-action="download">⬇ Save</button>`;
  }
  actHtml += `<button class="fc-btn icon" data-action="remove" aria-label="Remove">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg></button>`;

  el.innerHTML = `
    <div class="fc-ico">${icon}</div>
    <div class="fc-info">
      <div class="fc-name" title="${esc(entry.file.name)}">${esc(entry.file.name)}</div>
      <div class="fc-meta">${metaHtml}</div>
      ${progressHtml}
    </div>
    <div class="fc-actions">${actHtml}</div>
  `;

  el.querySelector('[data-action="compress"]')?.addEventListener('click', () => cbs.onCompress(entry));
  el.querySelector('[data-action="download"]')?.addEventListener('click', () => cbs.onDownload(entry));
  el.querySelector('[data-action="remove"]')?.addEventListener('click',   () => cbs.onRemove(entry.id));

  return el;
}

export function patchFileCard(entry: FileEntry, cbs: FileCardCallbacks) {
  const old = document.getElementById('card-' + entry.id);
  if (old) old.replaceWith(renderFileCard(entry, cbs));
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
}

// ── Batch bar helpers ─────────────────────────────────────────
export function renderBatchBar(
  container: HTMLElement,
  files: FileEntry[],
  onCompressAll: () => void,
  onDownloadAll: () => void,
  onClear:       () => void,
) {
  container.innerHTML = '';
  if (!files.length) { container.style.display = 'none'; return; }
  container.style.display = 'flex';

  const done  = files.filter(f => f.status === 'done').length;
  const queued = files.filter(f => f.status === 'idle' || f.status === 'error').length;

  const info = document.createElement('span');
  info.className = 'batch-info';
  info.textContent = `${files.length} file${files.length !== 1 ? 's' : ''} · ${done} done · ${queued} queued`;

  const btnAll = document.createElement('button');
  btnAll.className = 'btn-sm btn-run'; btnAll.textContent = 'Compress all';
  btnAll.addEventListener('click', onCompressAll);

  const btnDl = document.createElement('button');
  btnDl.className = 'btn-sm btn-dl'; btnDl.textContent = 'Download all';
  btnDl.addEventListener('click', onDownloadAll);

  const btnClr = document.createElement('button');
  btnClr.className = 'btn-sm btn-clr'; btnClr.textContent = 'Clear';
  btnClr.addEventListener('click', onClear);

  container.append(info, btnAll, btnDl, btnClr);
}
