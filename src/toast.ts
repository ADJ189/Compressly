export function toast(msg: string, type: 'success' | 'error' | '' = '') {
  const container = document.getElementById('toast')!;
  const el = document.createElement('div');
  el.className = 'toast-item' + (type ? ` ${type}` : '');
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 350);
  }, 3500);
}
