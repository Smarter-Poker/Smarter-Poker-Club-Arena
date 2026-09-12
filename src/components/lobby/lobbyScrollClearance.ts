/** The visible lobby owns its real scrollport, including an in-tab lobby. */
const owners = new WeakMap<HTMLElement, symbol>();

export function observeLobbyScrollClearance(bar: HTMLElement, cards: HTMLElement): () => void {
  const owner = Symbol('lobby-scrollport');
  let port: HTMLElement | null = null;
  const release = () => {
    if (port && owners.get(port) === owner) {
      port.removeAttribute('data-lobby-scrollport');
      port.style.removeProperty('--ca-lobby-sortbar-h');
      owners.delete(port);
    }
    port = null;
  };
  const measure = () => {
    if (!cards.getClientRects().length || !bar.getClientRects().length) {
      release();
      return;
    }
    let next = cards.parentElement;
    while (next && !/^(auto|scroll)$/.test(getComputedStyle(next).overflowY)) {
      next = next.parentElement;
    }
    next ??= document.scrollingElement as HTMLElement;
    if (port !== next) release();
    port = next;
    owners.set(port, owner);
    port.setAttribute('data-lobby-scrollport', 'true');
    port.style.setProperty('--ca-lobby-sortbar-h', `${bar.getBoundingClientRect().height}px`);
  };
  measure();
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
  observer?.observe(bar);
  observer?.observe(cards);
  window.addEventListener('resize', measure, { passive: true });
  return () => {
    observer?.disconnect();
    window.removeEventListener('resize', measure);
    release();
  };
}
