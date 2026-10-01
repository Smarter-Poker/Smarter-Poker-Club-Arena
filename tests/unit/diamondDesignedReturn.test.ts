import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DESIGNED_RETURN, designedReturn } from '../../src/utils/diamondDesignedReturn';

describe('designedReturn', () => {
  it('is the house 80 percent for the games without their own table', () => {
    expect(DESIGNED_RETURN).toBe(0.8);
    expect(designedReturn('crash', undefined)).toBe(0.8);
    expect(designedReturn('mines', [{ spec_rtp: 0.5, activated_at: '2026-09-01' }])).toBe(0.8);
  });

  it('reads the Plinko table activated last, and skips one not yet live', () => {
    expect(
      designedReturn('plinko', [
        { spec_rtp: 0.78, activated_at: '2026-09-20T00:00:00Z' },
        { spec_rtp: 0.79, activated_at: '2026-08-01T00:00:00Z' },
        { spec_rtp: 0.9, activated_at: null },
      ])
    ).toBe(0.78);
  });

  it('falls back to the house figure when no Plinko table states one', () => {
    expect(designedReturn('plinko', [{ spec_rtp: null, activated_at: '2026-09-20' }])).toBe(0.8);
    expect(designedReturn('plinko', [])).toBe(0.8);
  });
});

describe('the operator console prints what each game paid back', () => {
  const page = readFileSync('src/pages/club/ClubDiamondGamesOperationsPage.tsx', 'utf8');

  it('per window, and over the life of the game, next to what it is built to pay', () => {
    expect(page).toContain('{pct(w.realized_rtp)}');
    expect(page).toContain('value={pct(metrics?.realized_rtp_lifetime)}');
    expect(page).toContain('Built To Pay ${pct(designedReturn(game, metrics?.tables))}');
    expect(page).not.toContain('>Chips Paid</span>');
  });
});
