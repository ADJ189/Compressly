type Handler = () => void;
const handlers = new Map<string, Handler>();

export function on(route: string, fn: Handler) {
  handlers.set(route, fn);
}

export function navigate(route: string) {
  history.pushState({}, '', '/' + route);
  dispatch(route);
}

function dispatch(path: string) {
  const route = path.replace(/^\//, '').replace(/\/$/, '');
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
