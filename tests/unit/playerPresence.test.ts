/**
 * THE WHEEL NEVER SPINS TWICE UNATTENDED (2026-09-22): the one fact the rule
 * needs, "the last wheel spin was automatic and nobody has touched the page
 * since", and the only thing that clears it, a real input.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { noteAutomaticSpin, onPresenceChange, unattended } from '../../src/utils/playerPresence';

const KEY = 'diamond-spins-unattended';
const input = (type = 'pointerdown', target: EventTarget = document.body) =>
  target.dispatchEvent(new Event(type, { bubbles: true }));

afterEach(() => {
  vi.restoreAllMocks();
  // A real input is the public way back to a present player.
  input();
  sessionStorage.clear();
});

describe('an automatic spin leaves the tab unattended until somebody is there', () => {
  it('is false for a tab nobody has spun by itself', () => {
    expect(unattended()).toBe(false);
  });

  it('an automatic spin marks it, and the mark survives in the tab', () => {
    noteAutomaticSpin();
    expect(unattended()).toBe(true);
    expect(sessionStorage.getItem(KEY)).toBe('1');
  });

  it.each(['pointerdown', 'keydown', 'touchstart'])('a %s clears it', (type) => {
    noteAutomaticSpin();
    input(type);
    expect(unattended()).toBe(false);
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('hears the input in the capture phase, before any page handler can stop it', () => {
    noteAutomaticSpin();
    const button = document.createElement('button');
    document.body.appendChild(button);
    const stop = (event: Event) => event.stopPropagation();
    document.body.addEventListener('pointerdown', stop, true);
    input('pointerdown', button);
    document.body.removeEventListener('pointerdown', stop, true);
    button.remove();
    expect(unattended()).toBe(false);
  });

  it('is not cleared by what is not an input', () => {
    noteAutomaticSpin();
    for (const type of ['click', 'scroll', 'visibilitychange', 'focus', 'animationend'])
      input(type);
    expect(unattended()).toBe(true);
  });

  it('tells a subscriber each time it changes, until unsubscribed', () => {
    const heard = vi.fn();
    const stop = onPresenceChange(heard);
    noteAutomaticSpin();
    expect(heard).toHaveBeenCalledTimes(1);
    input('keydown');
    expect(heard).toHaveBeenCalledTimes(2);
    // An input with nothing marked changes nothing, and says nothing.
    input('keydown');
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    noteAutomaticSpin();
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

describe('a browser that will not store it', () => {
  it('keeps the answer in memory when session storage is blocked', () => {
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('The operation is insecure.');
    });
    noteAutomaticSpin();
    expect(unattended()).toBe(true);
    input('touchstart');
    expect(unattended()).toBe(false);
  });

  it('keeps it in memory when session storage refuses the write', () => {
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    } as unknown as Storage;
    vi.spyOn(window, 'sessionStorage', 'get').mockReturnValue(full);
    noteAutomaticSpin();
    expect(unattended()).toBe(true);
    input();
    expect(unattended()).toBe(false);
  });
});

describe('a new page load in the same tab', () => {
  it('still knows, and installs its one document listener once', async () => {
    sessionStorage.setItem(KEY, '1');
    vi.resetModules();
    const add = vi.spyOn(document, 'addEventListener');
    const fresh = await import('../../src/utils/playerPresence');
    expect(fresh.unattended()).toBe(true);
    fresh.unattended();
    fresh.noteAutomaticSpin();
    fresh.onPresenceChange(() => {})();
    const installed = add.mock.calls.filter(([type]) =>
      ['pointerdown', 'keydown', 'touchstart'].includes(type as string)
    );
    expect(installed.map(([type]) => type).sort()).toEqual([
      'keydown',
      'pointerdown',
      'touchstart',
    ]);
    for (const [, , options] of installed)
      expect(options).toMatchObject({ capture: true, passive: true });
    input();
    expect(fresh.unattended()).toBe(false);
    for (const [type, listener, options] of installed)
      document.removeEventListener(type, listener as EventListener, options);
  });
});
