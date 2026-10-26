# The horse VPIP target margin was measured, and kept

**Decision: no change.** Recorded so the next session does not repeat the
experiment.

## The question

On a 50% VPIP floor, horses aim at `vpipTargetFor(50)` = 70.6%: the floor plus
1.3 standard errors of a ten-hand sample (`VPIP_FLOOR_MARGIN_SIGMAS`,
`VPIP_JUDGED_OVER_HANDS`). `fn_nit_check` judges the cumulative rate of the
whole sitting, so at hand 100 the real sampling error is a third of the
ten-hand one, yet the margin never shrinks.

Measured on production 2026-10-24 (Midway PLO5 Classic at 50%, horse sittings
that began under the floor):

| hands into sitting | VPIP |
| ------------------ | ---- |
| 1-10               | 69.7 |
| 11-30              | 65.7 |
| 31-60              | 66.2 |
| 61-120             | 66.6 |
| 121+               | 65.4 |

## What was tried

A margin computed from the hands actually judged (`vpipTargetFor(floor,
judgedHands)`), identical at hand 10 and shrinking after it. Evaluated in a
closed-loop model driven by the real `vpipFloorMul` and `vpipFloorCallDown`
(seeded, 4,000 sittings of 150 hands, a sitting stood up the first time its
cumulative rate is under 50 from hand 10). With the shrink switched off the
model reproduces production (63.8-65.7% survivor VPIP), which is what makes its
comparison usable.

| margin floor (hands) | evicted, base width 0.28 | survivor VPIP | evicted, base width 0.38 | survivor VPIP |
| -------------------- | ------------------------ | ------------- | ------------------------ | ------------- |
| 10 (today)           | 3.5%                     | 63.8          | 0.9%                     | 64.9          |
| 15                   | 4.1%                     | 60.6          | 1.5%                     | 61.7          |
| 20                   | 4.7%                     | 58.8          | 1.6%                     | 59.9          |
| 30                   | 6.7%                     | 56.5          | 1.9%                     | 57.7          |
| uncapped             | 49.7%                    | 51.8          | 11.6%                    | 52.8          |

## Why it was not shipped

Near the target the widening's gain is small, so a horse aimed close to the
floor drifts under it late in a sitting: uncapped, half of all sittings were
stood up around hand 100. Capped, every few points of lower VPIP cost a third
to a half more evictions, and each eviction writes a two-hour bar on the game,
which is exactly the churn the 1.3-sigma margin was derived to prevent
(HorseLogic, "DERIVED, NOT GUESSED (2026-09-09)"). The current target stays.

The looseness that was a defect was the stale reader figure fixed by
`20261024232218_vpip_readers_judge_the_same_window_as_the_eviction.sql`
(PR #7966), which drove horses seated before the floor to 80%+.

## The model

The live `vpipTargetFor(floorPct)` takes no sample size, so the model needs the
experimental version applied to `server/src/engine/HorseLogic.ts` first (and
the two callers passing the seat's judged hands, `own?.hands`):

```ts
export function vpipTargetFor(
  floorPct: number,
  judgedHands: number = VPIP_JUDGED_OVER_HANDS
): number {
  const floor = Number(floorPct) / 100;
  if (!(floor > 0)) return 0;
  const hands = Number.isFinite(judgedHands)
    ? Math.max(VPIP_JUDGED_OVER_HANDS, Math.floor(judgedHands))
    : VPIP_JUDGED_OVER_HANDS;
  const se = Math.sqrt((floor * (1 - floor)) / hands);
  return Math.min(0.95, floor + VPIP_FLOOR_MARGIN_SIGMAS * se);
}
// in vpipFloorMul:      const target = vpipTargetFor(floor, own?.hands ?? VPIP_JUDGED_OVER_HANDS);
// in vpipFloorCallDown: const gap = vpipTargetFor(floor, own?.hands ?? VPIP_JUDGED_OVER_HANDS) - rate;
```

Then, from `server/`, `npx tsx <file> <base-width>`:

```ts
import { vpipFloorMul, vpipFloorCallDown } from './src/engine/HorseLogic.ts';
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const BASE = Number(process.argv[2] ?? 0.28);
const SMALL = 0.7;
function sitting(r: () => number, H: number, cap: number) {
  let played = 0;
  for (let n = 0; n < H; n++) {
    const own = n === 0 ? undefined : { hands: Math.min(n, cap), vpip: (100 * played) / n };
    let vp = r() < Math.min(0.98, BASE / vpipFloorMul({ vpipFloor: 50, ownVpip: own }));
    if (!vp && r() < SMALL)
      vp =
        vpipFloorCallDown(
          { action: 'fold', thinkTime: 0 } as any,
          { bet: 0, stack: 100 },
          { stage: 'preflop', currentBet: 1, bigBlind: 1, vpipFloor: 50, ownVpip: own },
          r
        ).action === 'call';
    if (vp) played++;
    const m = n + 1;
    if (m >= 10 && (100 * played) / m < 50) return { ev: m, v: (100 * played) / m };
  }
  return { ev: 0, v: (100 * played) / H };
}
for (const cap of [10, 12, 15, 20, 30]) {
  const r = rng(24301);
  let ev = 0,
    sum = 0;
  const N = 4000,
    H = 150;
  for (let i = 0; i < N; i++) {
    const s = sitting(r, H, cap);
    if (s.ev) ev++;
    else sum += s.v;
  }
  console.log(
    'cap',
    String(cap).padStart(2),
    'evicted',
    ((100 * ev) / N).toFixed(1).padStart(5) + '%',
    'survivor VPIP',
    (sum / (N - ev)).toFixed(1)
  );
}
```

It passes the sample capped at `cap` hands to both functions; that is the only
difference between rows, and `cap 10` reproduces the live brain. The uncapped
row is the same script with the list `[1000]`.
