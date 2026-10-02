/**
 * EVERY POP-UP PLATE ANSWERS THE FINGER (2026-10-01).
 *
 * On an iPhone browser the only buzz a page can get is a finger landing on a
 * native switch (TapHaptic). The game plates carried one; the pop-ups (the
 * cashier, deposit and withdraw, buy-in, insurance, the receipts) did not. A
 * SpadeConsole plate inside any dialog now carries it unless told otherwise.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PlateButton, SpadeConsole } from '../../src/components/console/SpadeConsole';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const asDevice = (ua: string) => vi.stubGlobal('navigator', { userAgent: ua, maxTouchPoints: 5 });
const ZONE = { x: 0, y: 0, width: 100, height: 40 };
const switches = (root: HTMLElement) => root.querySelectorAll('input[data-tap-haptic]').length;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('a plate in a pop-up buzzes on an iPhone browser', () => {
  it('carries the switch inside any dialog, and not on the page', () => {
    asDevice(IPHONE);
    const { container } = render(
      <>
        <div role="dialog" aria-modal="true" data-testid="popup">
          <PlateButton zone={ZONE} canvasH={100} label="Deposit" />
        </div>
        <section data-testid="page">
          <PlateButton zone={ZONE} canvasH={100} label="Open Lobby" />
        </section>
      </>
    );
    expect(switches(container.querySelector('[data-testid="popup"]')!)).toBe(1);
    expect(switches(container.querySelector('[data-testid="page"]')!)).toBe(0);
  });

  it('a whole console in a pop-up buzzes on every enabled plate, and never on a disabled one', () => {
    asDevice(IPHONE);
    const { container } = render(
      <div role="dialog">
        <SpadeConsole
          eyebrow="Cashier"
          title="Withdraw"
          plates={{
            secondary: { label: 'Cancel', onClick: () => undefined },
            primary: { label: 'Withdraw', onClick: () => undefined, disabled: true },
          }}
        >
          <p>Body</p>
        </SpadeConsole>
      </div>
    );
    expect(switches(container)).toBe(1);
  });

  it('keeps an explicit choice either way, and still hands the caller its button', () => {
    asDevice(IPHONE);
    const ref = createRef<HTMLButtonElement>();
    const { container } = render(
      <>
        <div role="dialog" data-testid="off">
          <PlateButton zone={ZONE} canvasH={100} label="Quiet" haptic={false} buttonRef={ref} />
        </div>
        <div data-testid="on">
          <PlateButton zone={ZONE} canvasH={100} label="Cash Out" haptic />
        </div>
      </>
    );
    expect(switches(container.querySelector('[data-testid="off"]')!)).toBe(0);
    expect(switches(container.querySelector('[data-testid="on"]')!)).toBe(1);
    expect(ref.current?.textContent).toBe('Quiet');
  });

  it('draws nothing in a pop-up off an iPhone browser', () => {
    asDevice(ANDROID);
    const { container } = render(
      <div role="dialog">
        <PlateButton zone={ZONE} canvasH={100} label="Deposit" />
      </div>
    );
    expect(switches(container)).toBe(0);
  });
});

describe('no focus trap lands on the invisible switch', () => {
  // The switch is tabIndex -1 and aria-hidden. A pop-up's own focus trap that
  // lists every enabled input would count it as its first or last stop, and
  // Tab would walk out of the pop-up (or open on the switch). Every trap
  // leaves tabindex -1 inputs out, the way Modal.tsx always has.
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  it('every enabled-input selector in src skips tabindex -1', () => {
    const offenders = files('src').filter((file) => {
      const text = readFileSync(file, 'utf8');
      return (
        /input:not\((\[disabled\]|:disabled)\)(?!:not\(\[tabindex="-1"\]\))/.test(text) ||
        text.includes("'input, button'")
      );
    });
    expect(offenders).toEqual([]);
  });
});
