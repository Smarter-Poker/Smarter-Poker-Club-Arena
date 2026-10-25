import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshPloRoster, getPloPerformance, PLO_ROSTER_TTL_MS } from './HorsePloRoster.js';
import { orderMadnessCandidates } from './HorseMadnessSelection.js';
const reads = vi.hoisted(() => ({
  fail: false,
  selection: '',
  rows: [{ horse_id: 'proven', plo_hands: '10000', plo_bb100: '15' }],
}));
vi.mock('./supabase/client.js', () => ({
  supabase: {
    from: (table: string) => ({
      select: (columns: string) => {
        if (table === 'ca_horse_plo_roster') reads.selection = columns;
        return {
          limit: async () =>
            table === 'ca_horse_plo_roster'
              ? {
                  data: reads.fail ? null : reads.rows,
                  error: reads.fail ? { message: 'unavailable' } : null,
                }
              : {
                  data: table === 'ca_horse_active_roster' ? [{ horse_id: 'proven' }] : [],
                  error: null,
                },
        };
      },
    }),
  },
}));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));

describe('the existing roster read supplies advisory Madness performance', () => {
  beforeEach(() => {
    reads.fail = false;
    reads.selection = '';
    vi.restoreAllMocks();
  });
  it('loads sample size and numeric performance with the existing roster request', async () => {
    await refreshPloRoster(true);
    expect(reads.selection).toContain('plo_hands');
    expect(reads.selection).toContain('plo_bb100');
    expect(getPloPerformance().get('proven')).toEqual({ hands: 10000, bb100: 15 });
    // Compose the real reader and selector: a parsed database result must
    // change which eligible horse reaches the first open Madness seat.
    const eligible = [
      { h: { id: 'unknown' }, w: 4 },
      { h: { id: 'proven' }, w: 1 },
    ];
    expect(
      orderMadnessCandidates(
        eligible,
        {
          game_variant: 'plo5',
          bomb_pot_enabled: true,
          big_blind_ante_enabled: true,
          nit_game: true,
          maintain_percent_min: 50,
        },
        getPloPerformance()
      )[0].h.id
    ).toBe('proven');
  });
  it('discards its preference on a failed read without denying eligibility', async () => {
    await refreshPloRoster(true);
    reads.fail = true;
    await refreshPloRoster(true);
    expect(getPloPerformance().size).toBe(0);
  });
  it('expires preferences instead of presenting an old read as current', async () => {
    await refreshPloRoster(true);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + PLO_ROSTER_TTL_MS + 1);
    expect(getPloPerformance().size).toBe(0);
  });
});
