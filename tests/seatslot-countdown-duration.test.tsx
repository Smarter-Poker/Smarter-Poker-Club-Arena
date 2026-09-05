/**
 * Dan 2026-08-19, bug list item 11: "the yellow countdown clock must take a
 * full 15 seconds."
 *
 * The ring is a pure-CSS animation whose duration SeatSlot derives as
 * (turnDeadlineMs - turnStartTimeMs). TablePage's ACTION_TIMER_STARTED handler
 * used to record only the DEADLINE, leaving turnStartTimeMs undefined/stale -
 * so the duration collapsed and the ring drained almost instantly. That was
 * fixed by recording the start time alongside the deadline; this test pins the
 * consumer end of that contract so a future handler change cannot quietly
 * collapse it again.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import SeatSlot from '../src/components/table/SeatSlot';

const NOW = new Date('2026-08-19T00:00:00Z').getTime();

const player = {
  id: 'p1',
  name: 'HERO',
  stack: 1000,
  status: 'active' as const,
  showCards: false,
  isHero: true,
};

function renderSeat(extra: Record<string, unknown>) {
  const { container } = render(
    <SeatSlot
      seatNumber={1}
      player={player}
      position={'BTN' as never}
      isActive
      lastAction={null as never}
      {...extra}
    />
  );
  return container.querySelector('.seat__info') as HTMLElement | null;
}

const durationSeconds = (el: HTMLElement | null) => {
  const raw = el?.style.getPropertyValue('--sp-timer-duration') ?? '';
  return parseFloat(raw.replace('s', ''));
};
const yellowSeconds = (el: HTMLElement | null) => {
  const raw = el?.style.getPropertyValue('--sp-timer-yellow-duration') ?? '';
  return parseFloat(raw.replace('s', ''));
};

describe('SeatSlot countdown ring duration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('spans the FULL 15 seconds on a normal turn', () => {
    const info = renderSeat({ turnStartTimeMs: NOW, turnDeadlineMs: NOW + 15_000 });
    expect(durationSeconds(info)).toBe(15);
    expect(yellowSeconds(info)).toBe(15);
  });

  it('does not collapse when the start time is missing', () => {
    // The regression shape: deadline recorded, start time not. Even then the
    // ring must fall back to a full turn rather than draining instantly.
    const info = renderSeat({ turnDeadlineMs: NOW + 15_000 });
    expect(durationSeconds(info)).toBe(15);
  });

  it('picks up mid-turn at the right position instead of restarting', () => {
    // 6s already elapsed: the ring still spans 15s but is offset by -6s.
    const info = renderSeat({ turnStartTimeMs: NOW - 6_000, turnDeadlineMs: NOW + 9_000 });
    expect(durationSeconds(info)).toBe(15);
    const delay = parseFloat(
      (info?.style.getPropertyValue('--sp-timer-delay') ?? '').replace('s', '')
    );
    expect(delay).toBeCloseTo(-6, 1);
  });

  it('yellow still owns only the first 15s when a time bank extends the turn', () => {
    const info = renderSeat({ turnStartTimeMs: NOW, turnDeadlineMs: NOW + 35_000 });
    expect(durationSeconds(info)).toBe(35);
    expect(yellowSeconds(info)).toBe(15);
  });

  it('never emits a sub-second duration', () => {
    const info = renderSeat({ turnStartTimeMs: NOW, turnDeadlineMs: NOW + 10 });
    expect(durationSeconds(info)).toBeGreaterThanOrEqual(1);
  });

  it('absorbs first-paint latency: the ring starts FULL and ends at the deadline (item 10, 2026-08-26)', () => {
    /* The engine stamps turn_start_time_ms before the broadcast reaches the
       phone, so the seat's first paint is typically 0.3-2.6s (deal hold) into
       the turn. The ring used to mount already part-drained and visibly
       emptied early. Small first-paint elapsed is now anchored out: the ring
       starts at 100% and spans exactly the REMAINING time, so it reaches
       empty at the fold / time-bank moment, never before. */
    const info = renderSeat({ turnStartTimeMs: NOW - 1_200, turnDeadlineMs: NOW + 13_800 });
    expect(durationSeconds(info)).toBeCloseTo(13.8, 1);
    const delay = parseFloat(
      (info?.style.getPropertyValue('--sp-timer-delay') ?? '').replace('s', '')
    );
    expect(delay).toBeCloseTo(0, 1);
  });
});

describe('the ring is linear: the arc that is left IS the time that is left (Dan 2026-09-05)', () => {
  it('carries no easing on the shrink - the 2026-08-21 linear() made a 15s ring read as 7.5', () => {
    const css = readFileSync(resolve(__dirname, '../src/components/table/SeatSlot.css'), 'utf8');
    const block = css
      .slice(css.indexOf('.seat--active .seat__info {'), css.indexOf('/* Outer glow container */'))
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(block).toMatch(/animation-timing-function: linear, linear;/);
    expect(block).not.toMatch(/linear\(/);
    expect(block).not.toMatch(/ease|cubic-bezier/);
  });
});
