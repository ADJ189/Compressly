import './style.css';
import { on, init, navigate } from './router';
import { mountImages } from './pages/images';
import { mountPdf }    from './pages/pdf';
import { mountVideo }  from './pages/video';
import { mountAudio }  from './pages/audio';
import { mountGif }    from './pages/gif';
import { mountOcr }    from './pages/ocr';

// ── Theme ─────────────────────────────────────────────────────
const html      = document.documentElement;
const themeIcon = document.getElementById('theme-icon')!;

const SUN  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
const MOON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

function applyTheme(t: string) {
  html.setAttribute('data-theme', t);
  localStorage.setItem('theme', t);
  if (themeIcon) themeIcon.innerHTML = t === 'dark' ? SUN : MOON;
  const lbl = document.getElementById('theme-label');
  if (lbl) lbl.textContent = t === 'dark' ? 'Light mode' : 'Dark mode';
}
document.getElementById('theme-btn')!.addEventListener('click', () =>
  applyTheme(html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));

const saved = localStorage.getItem('theme') ||
  (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
applyTheme(saved);

// ── Splash ────────────────────────────────────────────────────
setTimeout(() => document.getElementById('splash')!.classList.add('done'), 1150);

// ── Sidebar collapse ──────────────────────────────────────────
const sidebar = document.getElementById('sidebar')!;
const colBtn  = document.getElementById('sb-collapse')!;
let collapsed = localStorage.getItem('sb-collapsed') === '1';

function applyCollapse() {
  sidebar.classList.toggle('collapsed', collapsed);
  localStorage.setItem('sb-collapsed', collapsed ? '1' : '0');
}
colBtn?.addEventListener('click', () => { collapsed = !collapsed; applyCollapse(); });
applyCollapse();

// ── Mobile sidebar ────────────────────────────────────────────
const overlay  = document.getElementById('sidebar-overlay')!;
const mobMenuBtn = document.getElementById('mob-menu-btn')!;

function openMobSidebar() {
  sidebar.classList.add('mob-open');
  overlay.classList.add('visible');
  document.body.style.overflow = 'hidden';
}
function closeMobSidebar() {
  sidebar.classList.remove('mob-open');
  overlay.classList.remove('visible');
  document.body.style.overflow = '';
}
mobMenuBtn?.addEventListener('click', openMobSidebar);
overlay?.addEventListener('click', closeMobSidebar);

// Close mob sidebar on nav
document.addEventListener('click', e => {
  const item = (e.target as Element).closest('.sb-item');
  if (item && window.innerWidth <= 768) closeMobSidebar();
});

// ── Nav active state ──────────────────────────────────────────
function setActiveNav(route: string) {
  document.querySelectorAll('.sb-item').forEach(el => {
    const r = (el as HTMLElement).dataset.nav ?? '';
    const active = route === r || (r !== '' && route.startsWith(r + '/'));
    el.classList.toggle('active', active);
  });
}

// ── Page view with animation ──────────────────────────────────
const pageView = document.getElementById('page-view')!;

function mountPage(fn: (root: HTMLElement) => void) {
  pageView.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'page-enter';
  fn(wrapper);
  pageView.appendChild(wrapper);
  window.scrollTo(0, 0);
}

function showStatic(id: string) {
  pageView.innerHTML = '';
  const tpl = document.getElementById(id) as HTMLTemplateElement | null;
  if (!tpl) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'page-enter';
  wrapper.appendChild(tpl.content.cloneNode(true));
  pageView.appendChild(wrapper);
  window.scrollTo(0, 0);
}

// ── Routes ────────────────────────────────────────────────────
on('',                () => { setActiveNav('');         showStatic('tpl-home'); });
on('compress/images', () => { setActiveNav('compress/images'); mountPage(mountImages); });
on('compress/pdf',    () => { setActiveNav('compress/pdf');    mountPage(mountPdf); });
on('compress/video',  () => { setActiveNav('compress/video');  mountPage(mountVideo); });
on('compress/audio',  () => { setActiveNav('compress/audio');  mountPage(mountAudio); });
on('compress/gif',    () => { setActiveNav('compress/gif');    mountPage(mountGif); });
on('compress/ocr',    () => { setActiveNav('compress/ocr');    mountPage(mountOcr); });
on('about',           () => { setActiveNav('about');           showStatic('tpl-about'); });
on('docs',            () => { setActiveNav('docs');            showStatic('tpl-docs'); });
on('privacy',         () => { setActiveNav('privacy');         showStatic('tpl-privacy'); });
on('*',               () => { setActiveNav('');                showStatic('tpl-home'); });

init();

// Export navigate for inline onclick use in templates
(window as any).navigate = navigate;
