/**
 * AN iPHONE BROWSER BUZZES UNDER THE FINGER (2026-09-26).
 *
 * iOS 26.5 closed the scripted switch toggle, so the only web haptic left on an
 * iPhone is a finger landing on a real <input type="checkbox" switch>. These pin
 * that every tap target that should buzz carries one there, only there, only
 * when wanted and enabled, that the click still reaches the host, that the tap
 * is not buzzed twice, and that every host is a positioned box the invisible
 * switch can cover.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { TapHaptic } from '../../src/components/haptics/TapHaptic';
import {
  __resetVibrationCoalescing,
  fireVibration,
  setVibrationAllowed,
  SWITCH_TAP_WINDOW_MS,
  vibrationPath,
} from '../../src/utils/vibrationGate';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

const asDevice = (ua: string, vibrate?: (p: number | number[]) => boolean) =>
  vi.stubGlobal('navigator', { userAgent: ua, maxTouchPoints: 5, ...(vibrate ? { vibrate } : {}) });

const Host = ({ onClick, disabled = false }: { onClick: () => void; disabled?: boolean }) => (
  <button type="button" onClick={onClick} disabled={disabled}>
    Drop Diamonds
    <TapHaptic disabled={disabled} radius="4px" />
  </button>
);
const switchIn = (root: HTMLElement) => root.querySelector('input[data-tap-haptic]');

beforeEach(() => {
  localStorage.clear();
  __resetVibrationCoalescing();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('where the switch is drawn', () => {
  it('draws an invisible native switch over the host on an iPhone browser', () => {
    asDevice(IPHONE);
    expect(vibrationPath()).toBe('ios-taps');
    const { container } = render(<Host onClick={() => {}} />);
    const input = switchIn(container)!;
    expect(input).not.toBeNull();
    expect(input).toHaveAttribute('type', 'checkbox');
    expect(input).toHaveAttribute('switch', '');
    expect(input).toHaveAttribute('aria-hidden', 'true');
    expect(input).toHaveAttribute('tabindex', '-1');
    expect(input.parentElement!.tagName).toBe('BUTTON');
  });

  it('draws nothing on Android, on a computer or inside the app', () => {
    asDevice(ANDROID, () => true);
    expect(switchIn(render(<Host onClick={() => {}} />).container)).toBeNull();
    cleanup();
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140' });
    expect(switchIn(render(<Host onClick={() => {}} />).container)).toBeNull();
    cleanup();
    asDevice(IPHONE);
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'ios' });
    expect(vibrationPath()).toBe('app');
    expect(switchIn(render(<Host onClick={() => {}} />).container)).toBeNull();
  });

  it('draws nothing on a disabled host, so a button that does nothing never ticks', () => {
    asDevice(IPHONE);
    expect(switchIn(render(<Host onClick={() => {}} disabled />).container)).toBeNull();
  });

  it('follows the Vibrations switch live, and the test button ticks whatever it says', () => {
    asDevice(IPHONE);
    const { container } = render(
      <>
        <Host onClick={() => {}} />
        <button type="button">
          Test Vibration
          <TapHaptic ignorePreference />
        </button>
      </>
    );
    expect(container.querySelectorAll('input[data-tap-haptic]')).toHaveLength(2);
    act(() => setVibrationAllowed(false));
    expect(container.querySelectorAll('input[data-tap-haptic]')).toHaveLength(1);
    act(() => setVibrationAllowed(true));
    expect(container.querySelectorAll('input[data-tap-haptic]')).toHaveLength(2);
  });
});

describe('a tap on the switch', () => {
  it("reaches the host's own click handler", () => {
    asDevice(IPHONE);
    const onClick = vi.fn();
    const { container } = render(<Host onClick={onClick} />);
    fireEvent.click(switchIn(container)!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is one buzz: the scripted buzz the handler asks for in the same tap is not played again', () => {
    asDevice(IPHONE);
    const clicks: string[] = [];
    const real = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function (this: HTMLElement) {
      clicks.push(this.tagName);
    };
    try {
      let answered: boolean | null = null;
      const { container } = render(<Host onClick={() => (answered = fireVibration(25))} />);
      fireEvent.click(switchIn(container)!);
      // The finger already played the tick: reported as buzzed, and no scripted label click.
      expect(answered).toBe(true);
      expect(clicks).toEqual([]);
    } finally {
      HTMLElement.prototype.click = real;
    }
  });

  it('leaves a later scripted buzz alone once the tap window has passed', () => {
    asDevice(IPHONE);
    vi.useFakeTimers();
    try {
      const clicks: string[] = [];
      const real = HTMLElement.prototype.click;
      HTMLElement.prototype.click = function (this: HTMLElement) {
        clicks.push(this.tagName);
      };
      try {
        const { container } = render(<Host onClick={() => {}} />);
        fireEvent.click(switchIn(container)!);
        vi.advanceTimersByTime(SWITCH_TAP_WINDOW_MS + 100);
        fireVibration(50);
        expect(clicks).toEqual(['LABEL']);
      } finally {
        HTMLElement.prototype.click = real;
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('every host is a box the switch can cover', () => {
  const css = (path: string) => readFileSync(resolve(__dirname, '../..', path), 'utf8');
  /** The rule block for a selector, from its opening brace to its closing one. */
  const block = (source: string, selector: string) => {
    const at = source.indexOf(`${selector} {`);
    expect(at, `${selector} is not in the stylesheet`).toBeGreaterThanOrEqual(0);
    return source.slice(at, source.indexOf('}', at));
  };
  it.each([
    ['src/components/games/GameConsole.module.css', '.primary,\n.secondary'],
    ['src/components/games/GameConsole.module.css', '.metrics button'],
    ['src/components/wheel/WheelCabinet.module.css', '.primary'],
    ['src/components/wheel/WheelCabinet.module.css', '.secondary'],
    ['src/components/games/MinesGrid.module.css', '.tile'],
    ['src/components/wheel/WheelRunPanels.module.css', '.cardButton,\n.cardButtonQuiet'],
    ['src/components/wheel/WheelCardTable.module.css', '.card'],
    ['src/components/navigation/HamburgerMenu.module.css', '.toggleButton'],
    ['src/components/table/ActionPanel.css', '.raise-preset'],
    ['src/components/table/ActionPanel.css', '.raise-confirm'],
    ['src/components/device/DeviceCheck.module.css', '.test,\n.copy,\n.ask button'],
  ])('%s %s is positioned', (file, selector) => {
    expect(block(css(file), selector)).toMatch(/position:\s*(relative|absolute)/);
  });

  it('the table action buttons are positioned, and the switch outranks their relative children', () => {
    expect(block(css('src/components/table/ActionPanel.css'), '.action-panel .action-btn')).toMatch(
      /position:\s*relative/
    );
    expect(css('src/components/haptics/TapHaptic.module.css')).toContain(
      'position: absolute !important'
    );
  });
});
