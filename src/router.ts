export type Route = 'home' | 'compress' | 'compress/images' | 'compress/video' |
  'compress/pdf' | 'compress/audio' | 'compress/gif' | 'about' | 'docs';

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
  const route = path.replace(/^\//, '');
  const handler = handlers.get(route) ?? handlers.get('*');
  handler?.();
}

export function init() {
  window.addEventListener('popstate', () => dispatch(location.pathname));
  // Intercept all <a> and [data-nav] clicks
  document.addEventListener('click', e => {
    const el = (e.target as Element).closest('[data-nav]') as HTMLElement | null;
    if (!el) return;
    e.preventDefault();
    navigate(el.dataset.nav ?? '');
  });
  // Boot
  dispatch(location.pathname);
}
