import { act, cleanup, render } from '@testing-library/react';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DiamondWheel from '../../src/components/wheel/DiamondWheel';
import { WheelPrizeArt } from '../../src/components/wheel/WheelPrizeArt';
import { WheelWinReveal } from '../../src/components/wheel/WheelWinReveal';
import type { WheelSegment } from '../../src/services/DiamondWheelService';

// Owner rulings 2026-09-21:
//   R5  the selector is ONLY the centre holder with the blue diamond pointer,
//       centred on the wheel's axis; the long side arcs are gone.
//   R4  a Throwables win shows the combination throwables art, not the tomato.
//   R20 the phone was repainting two SVG wheels every frame: everything that
//       moves is its own HTML layer driven by transform or opacity, the
//       housing is painted once, and no SVG filter animates.

vi.mock('../../src/services/SoundService', () => ({
  soundService: {
    playSpinStart: vi.fn(),
    playSpinTicking: vi.fn(),
    playSpinPeg: vi.fn(),
    playSpinResult: vi.fn(),
    playBigWin: vi.fn(),
    playWin: vi.fn(),
  },
}));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../src/utils/animationSpeed', () => ({
  getAnimationSpeed: () => 1,
  prefersReducedMotion: () => false,
}));
vi.mock('../../src/components/common/Modal', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
}));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const ART = join(process.cwd(), 'public/assets/diamond-spins');
const segments = (kinds: string[]) =>
  kinds.map(
    (kind, i) =>
      ({ ord: i + 1, kind, amount: 5, multiplier: 1, weight: 1, label: kind }) as WheelSegment
  );
const twelve = segments([
  'bonus',
  'chips',
  'throwables',
  'chips',
  'bonus',
  'time_bank',
  'chips',
  'upgrade',
  'rabbit_hunt',
  'chips',
  'diamonds',
  'bonus',
]);

let observe: ((rect: { width: number; height: number }) => void) | null = null;
beforeEach(() => {
  // One wheel unit per CSS pixel: a 360 x 415 frame is exactly the assembly aperture.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: (entries: { contentRect: unknown }[]) => void) {
        observe = (rect) => this.callback([{ contentRect: rect }]);
      }
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  observe = null;
});

const mountMain = (extra: Partial<React.ComponentProps<typeof DiamondWheel>> = {}) => {
  const view = render(
    <DiamondWheel
      segments={twelve}
      landingOrd={null}
      spinKey={0}
      spinning={false}
      onLanded={vi.fn()}
      presentation="assembly"
      fitViewport
      {...extra}
    />
  );
  act(() => observe?.({ width: 360, height: 415 }));
  return view;
};

describe('R5: the selector is the holder and the pointer, on the axis', () => {
  it('draws the holder-only art centred on x=500 and no longer the arced mount', () => {
    const { container } = mountMain();
    const holder = container.querySelector('[data-wheel-selector] [data-selector-holder]')!;
    expect(holder).toBeTruthy();
    expect(holder.getAttribute('href')).toBe('/assets/diamond-spins/wheel-selector-holder-v2.webp');
    const x = Number(holder.getAttribute('x'));
    const width = Number(holder.getAttribute('width'));
    const height = Number(holder.getAttribute('height'));
    expect(x + width / 2).toBeCloseTo(500, 1);
    expect(width).toBeCloseTo(54.97, 1);
    expect(height / width).toBeCloseTo(310 / 520, 3);
    // The hub sits on the rim: the holder's top edge is above the rim's top (y=156).
    expect(Number(holder.getAttribute('y'))).toBeCloseTo(139, 0);
    expect(container.innerHTML).not.toContain('wheel-selector-mount-v1');
    expect(container.innerHTML).not.toContain('wheel-selector-matte-v1');
    expect(container.querySelectorAll('[data-wheel-selector]')).toHaveLength(1);
  });

  it('hangs the pointer from the pivot (500,156) as a transform-only HTML layer', () => {
    const { container } = mountMain();
    const pointer = container.querySelector<HTMLElement>('[data-selector-pointer]')!;
    expect(pointer).toBeInstanceOf(HTMLElement);
    expect(pointer.style.left).toBe('479px');
    expect(pointer.style.top).toBe('148px');
    expect(pointer.style.width).toBe('42px');
    expect(pointer.style.height).toBe('59px');
    expect(pointer.style.transformOrigin).toBe('21px 8px');
    const frames = [...pointer.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(frames).toEqual([
      '/assets/diamond-spins/wheel-selector-pointer-v2.webp',
      '/assets/diamond-spins/wheel-selector-pointer-glow-v2.webp',
    ]);
    // The pointer's own centre line is the wheel axis.
    expect(479 + 42 / 2).toBe(500);
  });

  it('shifts the whole selector by the same 124 units on the upgrade ring', () => {
    const { container } = mountMain({ upgraded: true, upgradeExpanded: true, showSelector: true });
    const selector = container.querySelector('[data-wheel-selector]')!;
    expect(selector.getAttribute('transform')).toBe('translate(0 -124)');
    const pointer = container.querySelector<HTMLElement>('[data-selector-pointer]')!;
    expect(pointer.style.top).toBe(`${148 - 124}px`);
    expect(pointer.style.transformOrigin).toBe('21px 8px');
  });
});

describe('R4: Throwables show the combination art everywhere the prize is shown', () => {
  it('renders the combination cutout for a throwables prize and the atlas for the rest', () => {
    const { container } = render(
      <>
        <WheelPrizeArt segment={{ kind: 'throwables' }} />
        <WheelPrizeArt segment={{ kind: 'time_bank' }} />
      </>
    );
    const [throwables, timeBank] = [...container.querySelectorAll('image')];
    expect(throwables.getAttribute('href')).toBe(
      '/assets/diamond-spins/wheel-prize-throwables-v1.webp'
    );
    expect(throwables.closest('svg')).toHaveAttribute('data-prize-art', 'throwables');
    expect(throwables.closest('svg')).toHaveAttribute('viewBox', '0 0 640 640');
    expect(timeBank.getAttribute('href')).toBe('/assets/diamond-spins/wheel-prize-atlas-v2.webp');
    // The tomato tile of the atlas is never the throwables reveal.
    expect(throwables.closest('svg')!.getAttribute('viewBox')).not.toBe('15 728 340 336');
  });

  it('opens the win reveal on the combination art', () => {
    const { container } = render(
      <WheelWinReveal
        prize={{ kind: 'throwables' }}
        title="5 Throwables"
        detail="Added To Your Account."
        onOpen={vi.fn()}
      />
    );
    expect(container.querySelector('[data-prize-art="throwables"] image')).toHaveAttribute(
      'href',
      '/assets/diamond-spins/wheel-prize-throwables-v1.webp'
    );
  });
});

describe('R20: what moves is a compositor layer, what does not is painted once', () => {
  it('rotates an HTML rotor whose sectors live in one SVG, and never an SVG attribute', () => {
    const { container } = mountMain();
    const rotor = container.querySelector<HTMLElement>('[data-wheel-rotor]')!;
    expect(rotor.tagName).toBe('DIV');
    expect(rotor.querySelectorAll('svg')).toHaveLength(1);
    expect(rotor.querySelectorAll('[data-slot]')).toHaveLength(12);
    // The rotor box is the wheel disc, centred on the axis.
    expect(rotor.style.left).toBe(`${500 - 352}px`);
    expect(rotor.style.width).toBe(`${2 * 352}px`);
    expect(rotor.getAttribute('transform')).toBeNull();
  });

  it('ships no SVG filter and animates the lamps as HTML elements, opacity only', () => {
    const { container } = mountMain({ upgraded: true });
    expect(container.querySelectorAll('filter, feDropShadow, feGaussianBlur')).toHaveLength(0);
    const lamps = container.querySelectorAll<HTMLElement>('i');
    expect(lamps).toHaveLength(48);
    expect(container.querySelectorAll('circle[class*="lamp"]')).toHaveLength(0);
    const [first] = lamps;
    expect(first.style.left).toBe(`${500 - 5}px`);
    expect(first.style.top).toBe(`${500 - 482 - 5}px`);
    expect(first.style.width).toBe('10px');
    expect(lamps[1].style.animationDelay).toBe('-0.045s');
  });

  it('keeps the housing, rim and holder in a static SVG behind the pointer and lamps', () => {
    const { container } = mountMain();
    const housing = container.querySelector('[data-wheel-static]')!;
    expect(housing.tagName.toLowerCase()).toBe('svg');
    expect(housing.querySelector('image[href$="wheel-matte-rim-v1.webp"]')).toBeTruthy();
    expect(housing.querySelector('[data-selector-holder]')).toBeTruthy();
    expect(housing.querySelector('[data-wheel-rotor]')).toBeNull();
    expect(housing.querySelector('[data-selector-pointer]')).toBeNull();
  });

  it('places the stage so the wheel axis is the frame centre for the assembly aperture', () => {
    const { container } = mountMain();
    const stage = container.querySelector<HTMLElement>('[data-wheel-face]')!;
    expect(stage.style.width).toBe('1000px');
    expect(stage.style.left).toBe(`${180 - 500}px`);
    expect(stage.style.top).toBe('0px');
    expect(stage.style.transform).toBe('scale(1)');
    expect(container.firstElementChild).toHaveAttribute('role', 'img');
    expect(container.firstElementChild).toHaveAttribute('aria-label', 'Diamond Wheel');
  });
});

describe('R20: the reveal and the controls stop re-filtering every frame', () => {
  const css = (file: string) =>
    readFileSync(join(process.cwd(), 'src/components/wheel', file), 'utf8');

  it('drops the blurred backdrop for the wheel reveal on phones and coarse pointers', () => {
    const reveal = css('WheelWinReveal.module.css');
    expect(reveal).toMatch(/@media \(pointer: coarse\), \(max-width: 700px\)/);
    expect(reveal).toContain('backdrop-filter: none');
    expect(reveal).toContain('-webkit-backdrop-filter: none');
    // A solid scrim in place of the blur, so the reveal still reads as a modal.
    expect(reveal).toMatch(/background: rgb\(0 0 0 \/ 8[0-9]%\)/);
    // The rays keep to transform and opacity.
    expect(reveal).toMatch(/@keyframes prize-rays \{\s*to \{\s*transform: rotate\(360deg\);/);
  });

  it('animates no filter anywhere in the wheel or its controls', () => {
    for (const file of [
      'DiamondWheel.module.css',
      'WheelCabinet.module.css',
      'WheelWinReveal.module.css',
    ]) {
      const source = css(file);
      const frames = source.split('@keyframes ').slice(1);
      expect(frames.length, `${file} has keyframes`).toBeGreaterThan(0);
      for (const frame of frames) {
        const body = frame.slice(0, frame.indexOf('\n}'));
        expect(body, `${file} animates a filter`).not.toMatch(/(^|[^-])filter:/);
      }
    }
  });

  it('pauses the decorative loops off screen and under reduced motion', () => {
    const wheel = css('DiamondWheel.module.css');
    expect(wheel).toContain('.frame[data-offscreen] .lamp');
    expect(wheel).toMatch(/\.frame\[data-offscreen\][\s\S]*animation-play-state: paused/);
    expect(wheel).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
  });
});

describe('the art the wheel names is sealed in the append-only pool', () => {
  it.each([
    'wheel-selector-holder-v2.png',
    'wheel-selector-holder-v2.webp',
    'wheel-selector-pointer-v2.png',
    'wheel-selector-pointer-v2.webp',
    'wheel-selector-pointer-glow-v2.png',
    'wheel-selector-pointer-glow-v2.webp',
    'wheel-prize-throwables-v1.webp',
    'wheel-prize-atlas-v2.webp',
    'wheel-matte-rim-v1.webp',
    'wheel-main-cards-v1.webp',
    'wheel-upgrade-cards-v1.webp',
    'wheel-upgrade-titles-v1.webp',
    // v1 files stay: the origin pool never loses a URL.
    'wheel-selector-mount-v1.png',
    'wheel-selector-matte-v1.png',
  ])('%s exists', (file) => {
    expect(existsSync(join(ART, file))).toBe(true);
  });
});
