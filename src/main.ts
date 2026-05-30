import './style.css';
import { navigate, on, init } from './router';
import { mountImages } from './pages/images';
import { mountPdf }    from './pages/pdf';
import { mountVideo }  from './pages/video';
import { mountAudio }  from './pages/audio';
import { mountGif }    from './pages/gif';

// ── Theme ─────────────────────────────────────────────────────
const html       = document.documentElement;
const themeBtn   = document.getElementById('theme-btn')!;
const SUN_ICO    = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
const MOON_ICO   = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

function applyTheme(t: string) {
  html.setAttribute('data-theme', t);
  localStorage.setItem('theme', t);
  themeBtn.innerHTML = t === 'dark' ? SUN_ICO : MOON_ICO;
}
themeBtn.addEventListener('click', () =>
  applyTheme(html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));

const saved = localStorage.getItem('theme') ||
  (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
applyTheme(saved);

// ── Splash dismiss ────────────────────────────────────────────
setTimeout(() => document.getElementById('splash')!.classList.add('done'), 1100);

// ── Nav active state ──────────────────────────────────────────
function setActiveNav(route: string) {
  document.querySelectorAll('.nav-link').forEach(el => {
    const r = (el as HTMLElement).dataset.nav ?? '';
    el.classList.toggle('active', route === r || route.startsWith(r + '/') && r !== '');
  });
}

// ── Main mount area ───────────────────────────────────────────
const mainEl = document.getElementById('main-content')!;

function mountPage(fn: (root: HTMLElement) => void) {
  mainEl.innerHTML = '';
  fn(mainEl);
  window.scrollTo(0, 0);
}

function showStatic(id: string) {
  mainEl.innerHTML = '';
  const tpl = document.getElementById(id) as HTMLTemplateElement | null;
  if (tpl) mainEl.appendChild(tpl.content.cloneNode(true));
  window.scrollTo(0, 0);
}

// ── Routes ────────────────────────────────────────────────────
on('', () => { setActiveNav(''); showStatic('tpl-home'); });
on('compress', () => { setActiveNav('compress'); showStatic('tpl-compress-index'); });
on('compress/images', () => { setActiveNav('compress'); mountPage(mountImages); });
on('compress/pdf',    () => { setActiveNav('compress'); mountPage(mountPdf); });
on('compress/video',  () => { setActiveNav('compress'); mountPage(mountVideo); });
on('compress/audio',  () => { setActiveNav('compress'); mountPage(mountAudio); });
on('compress/gif',    () => { setActiveNav('compress'); mountPage(mountGif); });
on('about', () => { setActiveNav('about'); showStatic('tpl-about'); });
on('docs',  () => { setActiveNav('docs');  showStatic('tpl-docs'); });
on('*', () => { setActiveNav(''); showStatic('tpl-home'); });

init();
