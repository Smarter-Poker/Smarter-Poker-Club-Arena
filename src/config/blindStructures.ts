import { SPIN_BLINDS } from './spinSpec';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BLIND STRUCTURES — pure data, no runtime dependencies
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Split out of TournamentService on 2026-08-19. The structures themselves are
 * plain arrays, but TournamentService also constructs the Supabase client at
 * import time, so anything that only wanted the ramps had to boot the client
 * (and, in a test, fail on a missing URL). TournamentService re-exports these,
 * so every existing import keeps working.
 */

export interface BlindLevel {
  level: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  durationMinutes: number;
  isBreak?: boolean;
}

/** Compact preset data; preserves every published level, ante and break. */
function blindLevels(minutes: number, rows: Array<[number, number]>): BlindLevel[] {
  return rows.map(([smallBlind, ante], i) => ({
    level: i + 1,
    smallBlind,
    bigBlind: smallBlind * 2,
    ante,
    durationMinutes: smallBlind === 0 ? 5 : minutes,
    ...(smallBlind === 0 ? { isBreak: true } : {}),
  }));
}
export const BLIND_STRUCTURES = {
  hyperTurbo: blindLevels(2, [
    [10, 0],
    [20, 0],
    [30, 0],
    [50, 10],
    [75, 15],
    [100, 25],
    [150, 40],
    [0, 0],
    [250, 60],
    [400, 100],
    [600, 150],
    [800, 200],
    [1000, 250],
    [0, 0],
    [1500, 400],
    [2000, 500],
    [3000, 750],
    [4000, 1000],
    [6000, 1500],
    [0, 0],
    [8000, 2000],
    [10000, 2500],
    [15000, 4000],
    [20000, 5000],
    [30000, 7500],
    [0, 0],
    [40000, 10000],
    [60000, 15000],
    [80000, 20000],
    [100000, 25000],
  ]),
  turbo: blindLevels(3, [
    [10, 0],
    [15, 0],
    [25, 0],
    [50, 5],
    [75, 10],
    [100, 15],
    [150, 25],
    [0, 0],
    [200, 30],
    [300, 50],
    [400, 75],
    [500, 100],
    [600, 150],
    [0, 0],
    [800, 200],
    [1000, 250],
    [1200, 300],
    [1500, 400],
    [2000, 500],
    [0, 0],
    [2500, 600],
    [3000, 750],
    [4000, 1000],
    [5000, 1200],
    [6000, 1500],
    [0, 0],
    [8000, 2000],
    [10000, 2500],
    [12000, 3000],
    [15000, 3500],
  ]),
  regular: blindLevels(8, [
    [10, 0],
    [15, 0],
    [20, 0],
    [25, 0],
    [50, 10],
    [75, 15],
    [100, 25],
    [0, 0],
    [150, 40],
    [200, 50],
    [300, 75],
    [400, 100],
    [500, 150],
    [0, 0],
    [600, 200],
    [800, 250],
    [1000, 300],
    [1200, 400],
    [1500, 500],
    [0, 0],
    [2000, 600],
    [2500, 750],
    [3000, 1000],
    [4000, 1200],
    [5000, 1500],
    [0, 0],
    [6000, 2000],
    [8000, 2500],
    [10000, 3000],
    [12000, 3500],
  ]),
  deepStack: blindLevels(15, [
    [10, 0],
    [15, 0],
    [20, 0],
    [25, 0],
    [50, 10],
    [0, 0],
    [75, 15],
    [100, 25],
    [150, 40],
    [0, 0],
    [200, 50],
    [300, 75],
    [400, 100],
    [0, 0],
    [500, 150],
    [600, 200],
    [800, 250],
    [0, 0],
    [1000, 300],
    [1200, 400],
    [1500, 500],
    [0, 0],
    [2000, 600],
    [2500, 750],
    [3000, 1000],
    [0, 0],
    [4000, 1200],
    [5000, 1500],
    [6000, 2000],
    [8000, 2500],
  ]),
  sng: blindLevels(6, [
    [10, 0],
    [15, 0],
    [20, 0],
    [25, 0],
    [50, 10],
    [75, 15],
    [100, 25],
    [150, 40],
    [200, 50],
    [300, 75],
    [400, 100],
    [500, 150],
    [600, 200],
    [800, 250],
    [1000, 300],
  ]),
};

/** The manual form's existing ramp keys. Both its setup presets and its
 * submitted ladder must resolve the same opening blind. */
export function manualTournamentBlindPreset(key: string): BlindLevel[] {
  switch (key) {
    case 'slow':
      return BLIND_STRUCTURES.deepStack;
    case 'turbo':
      return BLIND_STRUCTURES.turbo;
    case 'hyper_turbo':
      return BLIND_STRUCTURES.hyperTurbo;
    default:
      return BLIND_STRUCTURES.regular;
  }
}

/**
 * SPIN ladder — DERIVED from the canonical spinSpec (2026-08-30 audit fix).
 * There used to be a hand-typed 15-level ladder here that diverged from
 * src/config/spinSpec.ts SPIN_BLINDS at level 5 and claimed 2-minute levels.
 * The engine rewrites a Spin's blinds from spinSpec at start, so play was
 * correct — but the pre-start Blinds tab showed a ladder that would never be
 * played. One source of truth now: SPIN_BLINDS, 3-minute levels per the spec.
 */
export const SPIN_BLIND_STRUCTURE: BlindLevel[] = SPIN_BLINDS.map((b, i) => ({
  level: i + 1,
  smallBlind: b.small,
  bigBlind: b.big,
  ante: 0,
  durationMinutes: 3,
}));

/** Static payout shapes by field size. Pure data; see the note at the top. */
export const PAYOUT_STRUCTURES = {
  sng6: [
    { place: 1, percentage: 65 },
    { place: 2, percentage: 35 },
  ],
  sng9: [
    { place: 1, percentage: 50 },
    { place: 2, percentage: 30 },
    { place: 3, percentage: 20 },
  ],
  mtt10: [
    { place: 1, percentage: 50 },
    { place: 2, percentage: 30 },
    { place: 3, percentage: 20 },
  ],
  mtt20: [
    { place: 1, percentage: 38 },
    { place: 2, percentage: 27 },
    { place: 3, percentage: 18 },
    { place: 4, percentage: 10 },
    { place: 5, percentage: 7 },
  ],
  mtt50: [
    { place: 1, percentage: 28 },
    { place: 2, percentage: 18 },
    { place: 3, percentage: 13 },
    { place: 4, percentage: 10 },
    { place: 5, percentage: 8 },
    { place: 6, percentage: 6 },
    { place: 7, percentage: 5 },
    { place: 8, percentage: 4.5 },
    { place: 9, percentage: 4 },
    { place: 10, percentage: 3.5 },
  ],
  mtt100: [
    { place: 1, percentage: 25 },
    { place: 2, percentage: 16 },
    { place: 3, percentage: 11 },
    { place: 4, percentage: 8 },
    { place: 5, percentage: 6.5 },
    { place: 6, percentage: 5.5 },
    { place: 7, percentage: 4.5 },
    { place: 8, percentage: 4 },
    { place: 9, percentage: 3.5 },
    { place: 10, percentage: 3 },
    { place: 11, percentage: 3 },
    { place: 12, percentage: 2.5 },
    { place: 13, percentage: 2.5 },
    { place: 14, percentage: 2.5 },
    { place: 15, percentage: 2.5 },
  ],
  mtt200: [
    { place: 1, percentage: 23.8 },
    { place: 2, percentage: 13.5 },
    { place: 3, percentage: 9 },
    { place: 4, percentage: 6.8 },
    { place: 5, percentage: 5.5 },
    { place: 6, percentage: 4.5 },
    { place: 7, percentage: 3.5 },
    { place: 8, percentage: 3 },
    { place: 9, percentage: 2.5 },
    { place: 10, percentage: 2.2 },
    { place: 11, percentage: 2.2 },
    { place: 12, percentage: 2.2 },
    { place: 13, percentage: 1.9 },
    { place: 14, percentage: 1.9 },
    { place: 15, percentage: 1.9 },
    { place: 16, percentage: 1.6 },
    { place: 17, percentage: 1.6 },
    { place: 18, percentage: 1.6 },
    { place: 19, percentage: 1.4 },
    { place: 20, percentage: 1.4 },
    { place: 21, percentage: 1.4 },
    { place: 22, percentage: 1.2 },
    { place: 23, percentage: 1.2 },
    { place: 24, percentage: 1.2 },
    { place: 25, percentage: 1 },
    { place: 26, percentage: 1 },
    { place: 27, percentage: 1 },
  ],
};
