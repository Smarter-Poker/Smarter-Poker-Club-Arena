/**
 * THE CASH GAME CARD renders the props it is given over the supplied artwork
 * (Operation Table Stakes, 2026-09-04). The zones are percentages of the
 * 784 x 1168 frame; a zone that drifts off the artwork is a card that lies.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import CashGameCard, { rulesLineFor } from '../../src/components/cash/CashGameCard';

afterEach(cleanup);

const ROOT = process.cwd();

describe('the three pieces of artwork ship with the bundle', () => {
  it.each(['classic', 'action', 'madness'])('%s.webp is under public/images/cash-cards', (t) => {
    const file = path.join(ROOT, 'public', 'images', 'cash-cards', `${t}.webp`);
    expect(fs.existsSync(file)).toBe(true);
    // Lifted-out artwork, not the originals: a few hundred KB at most.
    expect(fs.statSync(file).size).toBeLessThan(400_000);
  });
});

describe('the card paints the changing parts', () => {
  const mount = (over: Partial<Parameters<typeof CashGameCard>[0]> = {}) =>
    render(
      <CashGameCard
        template="classic"
        stakesLabel="$1 / $2"
        variantLabel="No Limit Hold'em"
        status="running"
        mustMove
        players={57}
        tables={10}
        rulesLine="6-9 Handed · Traditional Rules · No Bomb Pots · Buy-In 40-200 BB"
        {...over}
      />
    );

  it('shows stakes, variant, status, mode, the four rows and the rules line', () => {
    mount();
    expect(screen.getByText('$1 / $2')).toBeTruthy();
    expect(screen.getByText("NO LIMIT HOLD'EM")).toBeTruthy();
    expect(screen.getByText('RUNNING')).toBeTruthy();
    expect(screen.getByText('MUST MOVE')).toBeTruthy();
    expect(screen.getByText('CLASSIC')).toBeTruthy();
    expect(screen.getByText('$1/$2')).toBeTruthy();
    expect(screen.getByText('57')).toBeTruthy();
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByText(/6-9 HANDED/)).toBeTruthy();
  });

  it('a manual game reads MANUAL, not MUST MOVE (R9)', () => {
    mount({ mustMove: false, template: 'action', status: 'waiting' });
    expect(screen.getByText('MANUAL')).toBeTruthy();
    expect(screen.queryByText('MUST MOVE')).toBeNull();
    expect(screen.getByText('WAITING')).toBeTruthy();
    expect(screen.getByText('ACTION')).toBeTruthy();
  });

  it('uses the artwork for its template', () => {
    mount({ template: 'madness' });
    const img = document.querySelector('img.cgc__art') as HTMLImageElement;
    expect(img.getAttribute('src')).toMatch(/images\/cash-cards\/madness\.webp$/);
  });

  it('every zone sits inside the frame', () => {
    mount();
    for (const el of document.querySelectorAll<HTMLElement>('.cgc__zone, .cgc__hit')) {
      const left = parseFloat(el.style.left);
      const top = parseFloat(el.style.top);
      const width = parseFloat(el.style.width);
      const height = parseFloat(el.style.height);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(left + width).toBeLessThanOrEqual(100.001);
      expect(top + height).toBeLessThanOrEqual(100.001);
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
    }
  });

  it('View and Join are real buttons over the painted faces', () => {
    const onView = vi.fn();
    const onJoin = vi.fn();
    mount({ onView, onJoin });
    fireEvent.click(screen.getByRole('button', { name: 'View Game' }));
    fireEvent.click(screen.getByRole('button', { name: 'Join Game' }));
    expect(onView).toHaveBeenCalledTimes(1);
    expect(onJoin).toHaveBeenCalledTimes(1);
  });

  it('a long stakes label shrinks rather than overflowing the zone', () => {
    mount({ stakesLabel: '$0.05 / $0.10' });
    const el = screen.getByText('$0.05 / $0.10') as HTMLElement;
    expect(Number(el.style.getPropertyValue('--cgc-fit'))).toBeLessThan(1);
    expect(Number(el.style.getPropertyValue('--cgc-fit'))).toBeGreaterThan(0);
  });
});

describe('rulesLineFor speaks the artwork wording from a snapshot', () => {
  it('classic hold em', () => {
    expect(
      rulesLineFor({
        seats: 9,
        seat_choices: [9, 6],
        seats_locked: false,
        min_buyin_bb: 40,
        max_buyin_bb: 200,
        regular_ante: 'none',
        vpip_floor: 0,
        bombs: { enabled: false, trigger: null, boards: null },
      })
    ).toBe('6-9 Handed · Traditional Rules · No Bomb Pots · Buy-In 40-200 BB');
  });

  it('action', () => {
    expect(
      rulesLineFor({
        seats: 6,
        seat_choices: [2, 3, 4, 5, 6, 7, 8, 9],
        min_buyin_bb: 50,
        max_buyin_bb: 200,
        regular_ante: 'sb',
        vpip_floor: 30,
        bombs: { enabled: true, trigger: 'timed_15m', boards: 2 },
      })
    ).toBe('6-Max · 30% VPIP · 1 SB Ante · Bombs Every 15 Min · Double Board');
  });

  it('madness omaha', () => {
    expect(
      rulesLineFor({
        seats: 6,
        seat_choices: [6],
        seats_locked: true,
        regular_ante: 'bb',
        vpip_floor: 70,
        bombs: { enabled: true, trigger: 'every_orbit', boards: 2 },
      })
    ).toBe('6-Max · 70% VPIP · 1 BB Ante · Bombs Every Orbit · Double Board');
  });

  it('never uses an em dash as a separator (CLAUDE.md 10.7)', () => {
    expect(rulesLineFor({ seats: 6 })).not.toMatch(/—/);
  });
});
