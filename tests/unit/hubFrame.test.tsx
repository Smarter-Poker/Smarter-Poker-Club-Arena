/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HubFrame — what the frame does besides showing the page (Dan 2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Mounted for real, with the frame's own document, so every behaviour below
 * is exercised rather than grepped for:
 *   - an off-site link opens a real browser tab, never the frame (Stripe and
 *     OAuth refuse to render framed);
 *   - a link back into Club Arena is handed to the container;
 *   - an ordinary World Hub link is left alone;
 *   - keystrokes inside the frame reach the strip;
 *   - going inactive pauses whatever is playing;
 *   - an idle frame is unloaded, and reloaded on return, at its last page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { createRef } from 'react';
import {
  HubFrame,
  pauseMediaIn,
  type HubFrameSwipeHandlers,
} from '../../src/components/table/HubFrame';
import { HUB_FRAME_IDLE_SUSPEND_MS, HUB_FRAME_STALL_MS } from '../../src/utils/hubTab';

const swipe = createRef<HubFrameSwipeHandlers>() as React.RefObject<HubFrameSwipeHandlers>;
(swipe as { current: HubFrameSwipeHandlers }).current = {
  start: vi.fn(),
  move: vi.fn(),
  end: vi.fn(),
};

function mount(overrides: Partial<React.ComponentProps<typeof HubFrame>> = {}) {
  const onLocationChange = vi.fn();
  const onClubArenaTarget = vi.fn();
  const keys = { current: vi.fn() } as React.RefObject<(e: KeyboardEvent) => void>;
  const utils = render(
    <HubFrame
      tabId="hub:1"
      src="/hub/social"
      title="Social"
      active
      swipe={swipe}
      keys={keys}
      onLocationChange={onLocationChange}
      onClubArenaTarget={onClubArenaTarget}
      {...overrides}
    />
  );
  const iframe = utils.container.querySelector('iframe') as HTMLIFrameElement;
  return { ...utils, iframe, onLocationChange, onClubArenaTarget, keys };
}

/**
 * happy-dom gives a frame no document unless it can LOAD the page, and the
 * page is not the subject here. So the test supplies one: a real Document,
 * installed as the frame's `contentDocument`, then the frame's `load` event -
 * which is exactly the path a real navigation inside the frame takes, and the
 * component re-attaches its listeners through it.
 */
const docOf = (iframe: HTMLIFrameElement): Document => {
  const doc = document.implementation.createHTMLDocument('hub');
  Object.defineProperty(doc, 'baseURI', {
    value: `${window.location.origin}/hub/social`,
    configurable: true,
  });
  Object.defineProperty(iframe, 'contentDocument', { value: doc, configurable: true });
  Object.defineProperty(iframe, 'contentWindow', {
    value: { location: { href: `${window.location.origin}/hub/social` } },
    configurable: true,
  });
  act(() => {
    iframe.dispatchEvent(new Event('load'));
  });
  return doc;
};

const clickAnchor = (doc: Document, href: string) => {
  const a = doc.createElement('a');
  a.setAttribute('href', href);
  a.textContent = 'x';
  doc.body.appendChild(a);
  const ev = new (doc.defaultView?.MouseEvent ?? MouseEvent)('click', {
    bubbles: true,
    cancelable: true,
  });
  a.dispatchEvent(ev);
  return ev;
};

/* happy-dom would otherwise try to FETCH /hub/social for every frame and
   follow every un-prevented anchor; the frame's page is not the subject here,
   its document is. */
type HappyWindow = Window & {
  happyDOM?: {
    settings: {
      disableIframePageLoading: boolean;
      navigation: { disableChildFrameNavigation: boolean; disableChildPageNavigation: boolean };
    };
  };
};
beforeEach(() => {
  const settings = (window as HappyWindow).happyDOM?.settings;
  if (settings) {
    settings.disableIframePageLoading = true;
    settings.navigation.disableChildFrameNavigation = true;
    settings.navigation.disableChildPageNavigation = true;
  }
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('HubFrame renders the one sanctioned frame', () => {
  it('is an <iframe> on the World Hub path, same origin, no sandbox', () => {
    const { iframe } = mount();
    expect(iframe).toBeTruthy();
    expect(iframe.getAttribute('src')).toBe('/hub/social');
    expect(iframe.hasAttribute('sandbox')).toBe(false);
    expect(iframe.getAttribute('data-hub-active')).toBe('true');
  });

  it('does not rewrite src when the tracked page changes (that would reload the player)', () => {
    const { iframe, rerender } = mount();
    rerender(
      <HubFrame
        tabId="hub:1"
        src="/hub/media"
        title="Media"
        active
        swipe={swipe}
        onLocationChange={vi.fn()}
        onClubArenaTarget={vi.fn()}
      />
    );
    expect(iframe.getAttribute('src')).toBe('/hub/social');
  });
});

describe('links inside the frame', () => {
  it('off-site: opens a real browser tab and stops the frame following it', () => {
    const { iframe } = mount();
    const doc = docOf(iframe);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const ev = clickAnchor(doc, 'https://checkout.stripe.com/pay/cs_test_123');
    expect(open).toHaveBeenCalledWith(
      'https://checkout.stripe.com/pay/cs_test_123',
      '_blank',
      'noopener,noreferrer'
    );
    expect(ev.defaultPrevented).toBe(true);
  });

  it('back into Club Arena: handed to the container, frame never follows', () => {
    const { iframe, onClubArenaTarget } = mount();
    const doc = docOf(iframe);
    const ev = clickAnchor(doc, '/hub/club-arena/clubs/abc?tab=games');
    expect(onClubArenaTarget).toHaveBeenCalledWith('hub:1', '/clubs/abc?tab=games');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('a World Hub link is left alone', () => {
    const { iframe, onClubArenaTarget } = mount();
    const doc = docOf(iframe);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const ev = clickAnchor(doc, '/hub/media');
    expect(open).not.toHaveBeenCalled();
    expect(onClubArenaTarget).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('mailto: and other non-http schemes are left to the browser', () => {
    const { iframe } = mount();
    const doc = docOf(iframe);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const ev = clickAnchor(doc, 'mailto:support@smarter.poker');
    expect(open).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('input inside the frame reaches the strip', () => {
  it('forwards Alt+Arrow to the keys ref, and leaves Tab and digits to the page', () => {
    const { iframe, keys } = mount();
    const doc = docOf(iframe);
    const KE = doc.defaultView?.KeyboardEvent ?? KeyboardEvent;
    doc.dispatchEvent(new KE('keydown', { key: '2', bubbles: true }));
    doc.dispatchEvent(new KE('keydown', { key: 'Tab', bubbles: true }));
    expect(keys.current).not.toHaveBeenCalled();
    doc.dispatchEvent(new KE('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }));
    expect(keys.current).toHaveBeenCalledTimes(1);
    expect((keys.current as ReturnType<typeof vi.fn>).mock.calls[0][0].key).toBe('ArrowRight');
  });

  it('forwards touches to the swipe ref', () => {
    const { iframe } = mount();
    const doc = docOf(iframe);
    const TE = (doc.defaultView as unknown as { TouchEvent?: typeof Event })?.TouchEvent ?? Event;
    doc.dispatchEvent(new TE('touchstart', { bubbles: true }));
    doc.dispatchEvent(new TE('touchend', { bubbles: true }));
    expect(swipe.current.start).toHaveBeenCalled();
    expect(swipe.current.end).toHaveBeenCalled();
  });
});

describe('a page that is still coming says so', () => {
  it('shows the loading overlay, named for the page, until the frame loads', () => {
    const { iframe, container } = mount();
    const wrap = container.querySelector('.hub-frame') as HTMLElement;
    expect(wrap.getAttribute('data-hub-loading')).toBe('true');
    expect(container.querySelector('.hub-frame__overlay')?.textContent).toContain('Loading Social');
    expect(container.querySelector('.hub-frame__reload')).toBeNull();
    docOf(iframe); // the page arrives
    expect(wrap.getAttribute('data-hub-loading')).toBe('false');
    expect(container.querySelector('.hub-frame__overlay')).toBeNull();
  });

  it('offers Reload once the page has stalled, and Reload re-requests the page', () => {
    const { iframe, container } = mount();
    act(() => vi.advanceTimersByTime(HUB_FRAME_STALL_MS - 1));
    expect(container.querySelector('.hub-frame__reload')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    const btn = container.querySelector('.hub-frame__reload') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    act(() => btn.click());
    expect(iframe.src.endsWith('/hub/social')).toBe(true);
    expect(container.querySelector('.hub-frame__reload')).toBeNull(); // clock restarted
  });

  it('never shows the overlay on a frame that has not been armed', () => {
    const { container } = mount({ active: false });
    expect(container.querySelector('.hub-frame__overlay')).toBeNull();
  });
});

describe('a frame nobody has looked at yet', () => {
  it('does not load until its tab is on screen once, then stays loaded', () => {
    const props = {
      tabId: 'hub:1',
      src: '/hub/social',
      title: 'Social',
      swipe,
      onLocationChange: vi.fn(),
      onClubArenaTarget: vi.fn(),
    };
    const { iframe, rerender } = mount({ active: false });
    expect(iframe.hasAttribute('src')).toBe(false);
    // Nothing to unload either: the idle timer must not blank a frame that
    // was never loaded (it would then "restore" it on return and boot it).
    vi.advanceTimersByTime(HUB_FRAME_IDLE_SUSPEND_MS + 1);
    expect(iframe.hasAttribute('src')).toBe(false);
    rerender(<HubFrame {...props} active />);
    expect(iframe.getAttribute('src')).toBe('/hub/social');
    rerender(<HubFrame {...props} active={false} />);
    expect(iframe.getAttribute('src')).toBe('/hub/social');
  });
});

describe('a frame the player is not looking at', () => {
  it('pauseMediaIn pauses only what is playing', () => {
    const doc = document.implementation.createHTMLDocument('m');
    const playing = doc.createElement('video');
    const idle = doc.createElement('audio');
    Object.defineProperty(playing, 'paused', { value: false, configurable: true });
    Object.defineProperty(idle, 'paused', { value: true, configurable: true });
    const p1 = vi.fn();
    const p2 = vi.fn();
    Object.defineProperty(playing, 'pause', { value: p1, configurable: true });
    Object.defineProperty(idle, 'pause', { value: p2, configurable: true });
    doc.body.append(playing, idle);
    expect(pauseMediaIn(doc)).toBe(1);
    expect(p1).toHaveBeenCalledTimes(1);
    expect(p2).not.toHaveBeenCalled();
  });

  it('going inactive pauses the media in the frame document', () => {
    const { iframe, rerender } = mount();
    const doc = docOf(iframe);
    const video = doc.createElement('video');
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    const pause = vi.fn();
    Object.defineProperty(video, 'pause', { value: pause, configurable: true });
    doc.body.appendChild(video);
    rerender(
      <HubFrame
        tabId="hub:1"
        src="/hub/social"
        title="Social"
        active={false}
        swipe={swipe}
        onLocationChange={vi.fn()}
        onClubArenaTarget={vi.fn()}
      />
    );
    expect(pause).toHaveBeenCalledTimes(1);
    expect(iframe.getAttribute('data-hub-active')).toBe('false');
  });

  it('is unloaded after the idle window and reloaded on return, at its page', () => {
    const props = {
      tabId: 'hub:1',
      src: '/hub/social',
      title: 'Social',
      swipe,
      onLocationChange: vi.fn(),
      onClubArenaTarget: vi.fn(),
      idleSuspendMs: 1000,
    };
    // Seen once (so it loaded), then left behind another tab.
    const { iframe, rerender } = mount({ active: true, idleSuspendMs: 1000 });
    rerender(<HubFrame {...props} active={false} />);
    // Not yet: the window has not elapsed.
    vi.advanceTimersByTime(999);
    expect(iframe.src.endsWith('about:blank')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(iframe.src.endsWith('about:blank')).toBe(true);
    // Back on screen: the page comes back.
    rerender(<HubFrame {...props} active />);
    expect(iframe.src.endsWith('/hub/social')).toBe(true);
  });

  it('a tab switched away from and back before the window is never unloaded', () => {
    const props = {
      tabId: 'hub:1',
      src: '/hub/social',
      title: 'Social',
      swipe,
      onLocationChange: vi.fn(),
      onClubArenaTarget: vi.fn(),
      idleSuspendMs: 1000,
    };
    const { iframe, rerender } = mount({ active: true, idleSuspendMs: 1000 });
    rerender(<HubFrame {...props} active={false} />);
    vi.advanceTimersByTime(500);
    rerender(<HubFrame {...props} active />);
    vi.advanceTimersByTime(5000);
    expect(iframe.src.endsWith('about:blank')).toBe(false);
  });
});
