import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureThrowableAvatar } from '../../src/throwables/avatarSnapshot';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('throwable avatar copies', () => {
  it('copies the decoded image from its own table without modifying the seat', () => {
    document.body.innerHTML =
      '<main class="table-page"><section data-seat-num="2"><div class="seat__avatar"><img class="seat__avatar-img" src="/wrong.webp"></div></section></main><main class="table-page"><section data-seat-num="2"><div class="seat__avatar"><img class="seat__avatar-img" src="/right.webp"></div></section><div id="throw"></div></main>';
    const images = document.querySelectorAll('img');
    for (const img of images) {
      Object.defineProperty(img, 'complete', { value: true });
      Object.defineProperty(img, 'naturalWidth', { value: 200 });
    }
    Object.defineProperty(images[1], 'currentSrc', { value: 'https://example.test/right@2x.webp' });
    const before = document.body.innerHTML;
    expect(captureThrowableAvatar(document.getElementById('throw'), 2)).toEqual({
      src: 'https://example.test/right@2x.webp',
    });
    expect(document.body.innerHTML).toBe(before);
    expect(captureThrowableAvatar(document.body, 2)).toBeUndefined();
  });

  it('does not invent an avatar when avatars are disabled or the target is absent', () => {
    document.body.innerHTML =
      '<main class="table-page"><section data-seat-num="2"><div class="seat__avatar"></div></section><div id="throw"></div></main>';
    const root = document.getElementById('throw');
    expect(captureThrowableAvatar(root, 2)).toBeUndefined();
    expect(captureThrowableAvatar(root, 3)).toBeUndefined();
    expect(captureThrowableAvatar(root, NaN)).toBeUndefined();
  });

  it('uses the visible initial and tolerates a canvas that cannot be copied', () => {
    document.body.innerHTML =
      '<main class="table-page"><section data-seat-num="2"><div class="seat__avatar"><div class="seat__avatar-rive"><canvas width="100" height="100"></canvas></div><span class="seat__avatar-initial">D</span></div></section><div id="throw"></div></main>';
    vi.spyOn(document.querySelector('canvas')!, 'toDataURL').mockImplementation(() => {
      throw new Error('tainted');
    });
    expect(captureThrowableAvatar(document.getElementById('throw'), 2)).toEqual({ initial: 'D' });
  });
});
