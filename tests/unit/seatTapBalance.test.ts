/**
 * THE SEAT TAP KNOWS WHETHER YOU CAN AFFORD THE GAME (Dan 2026-10-14).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { seatTapBalanceVerdict, notEnoughChipsText } from '../../src/lib/seatTapBalance';

describe('seatTapBalanceVerdict', () => {
  it('a read balance below the minimum is short', () => {
    expect(seatTapBalanceVerdict(84, 100)).toBe('short');
  });
  it('enough is enough, exactly at the minimum too', () => {
    expect(seatTapBalanceVerdict(100, 100)).toBe('ok');
    expect(seatTapBalanceVerdict(5000, 100)).toBe('ok');
  });
  it('an unread balance is never short', () => {
    expect(seatTapBalanceVerdict(null, 100)).toBe('unknown');
  });
});

describe('notEnoughChipsText', () => {
  it('names the game minimum and the balance, Title Case, no em dash', () => {
    const t = notEnoughChipsText(100, 84);
    expect(t).toBe(
      'You Do Not Have Enough Chips For This Game. The Minimum Buy In Is 100 Chips And Your Balance Is 84 Chips.'
    );
    expect(t).not.toContain('—');
  });
});

describe('the table page', () => {
  const PAGE = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
  it('never answers a seat tap with a funding popup', () => {
    expect(PAGE).not.toContain("toast.warning('Verifying Table Funding')");
  });
  it('refuses a short balance out loud on the seat tap', () => {
    expect(PAGE).toContain('toast.error(notEnoughChipsText(needed, balance as number, unit))');
  });
});
