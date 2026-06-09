type Handler = () => void;
const handlers = new Map<string, Handler>();

// Derive the deployment base once (e.g. "/" on root, "/compressz/" on a sub-path).
// Vite injects BASE_URL at build time via import.meta.env; the declaration below
// satisfies the TypeScript compiler without needing a separate vite-env.d.ts.
declare const __VITE_BASE__: string | undefined;
const BASE: string = (import.meta as any).env?.BASE_URL ?? '/';
const BASE_NORM = BASE.endsWith('/') ? BASE : BASE + '/';

export function on(route: string, fn: Handler) {
  handlers.set(route, fn);
}

export function navigate(route: string) {
  history.pushState({}, '', BASE_NORM + route);
  dispatch(BASE_NORM + route);
}

function dispatch(path: string) {
  // Strip the base prefix, then normalise leading/trailing slashes.
  const stripped = path.startsWith(BASE_NORM)
    ? path.slice(BASE_NORM.length)
    : path.replace(/^\//, '');
  const route = stripped.replace(/\/$/, '');
  const handler = handlers.get(route) ?? handlers.get('*');
  handler?.();
}

export function init() {
  window.addEventListener('popstate', () => dispatch(location.pathname));
  document.addEventListener('click', e => {
    const el = (e.target as Element).closest('[data-nav]') as HTMLElement | null;
    if (!el) return;
    // Don't intercept external links (href with http/https)
    const href = (el as HTMLAnchorElement).href;
    if (href && (href.startsWith('http://') || href.startsWith('https://')) && !href.includes(location.hostname)) return;
    e.preventDefault();
    navigate(el.dataset.nav ?? '');
  });
  dispatch(location.pathname);
}
