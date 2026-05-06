# Problem 020 — Horse Raise/Bet Amounts Had Sub-Cent Float Precision

**Type:** PROBLEM
**Project:** Smarter Poker Club Arena
**Date Found:** 2026-04-15 (Wave 1 audit — action amount precision)
**Date Fixed:** 2026-04-15 (server code fix, pending Hetzner redeploy)
**Severity:** MEDIUM — integrity / audit violation, no financial loss observed

## Discovery

```sql
SELECT COUNT(*) FILTER (WHERE (elem->>'amount')::numeric * 100 != FLOOR((elem->>'amount')::numeric * 100)) AS sub_cent_actions,
       COUNT(*) AS total_actions
FROM hand_history, jsonb_array_elements(actions) elem
WHERE created_at > NOW() - INTERVAL '1 hour';
-- sub_cent_actions: 136
-- total_actions: 296
```

**46% of all hand actions in the last hour had sub-cent precision.** Sample values:

- `5.007319350536557`
- `5.1456674836726615`
- `4.9231`

Bible V8 §2.6 mandates integer-cent arithmetic for chip amounts (`"integer-cent arithmetic, proper eligibility"` — pot object spec). Fractional chips below 1 cent don't exist on a poker table.

## Root cause

`server/src/engine/HorseLogic.ts` generates horse (bot) raise sizing via:

```ts
const openSize = bigBlind * (2.5 + Math.random() * 0.5);
return { action: 'raise', amount: Math.min(stack, openSize), thinkTime: 0 };
```

Six preflop sites use `Math.random() * X` without rounding, producing float amounts. Postflop sites partially rounded via `Math.trunc(... * 100) / 100` but inconsistently — some paths still emitted the raw float.

## Fix

Added a single helper at the top of `HorseLogic.ts`:

```ts
const toCents = (n: number): number => Math.round(n * 100) / 100;
```

Wrapped every `amount:` output that uses `Math.random()` or multiplier-based sizing with `toCents(...)`:

**Preflop sites (6):**

- Line 111: `toCents(Math.min(stack, currentBet * 2.5))` — 3-bet response
- Line 116: `toCents(Math.min(stack, currentBet * 3))` — raise vs open
- Line 119: `toCents(Math.min(stack, openSize))` — nut hand open
- Line 129: `toCents(Math.min(stack, currentBet * 3))` — 3-bet threshold hands
- Line 135: `toCents(Math.min(stack, openSize))` — PFR-threshold hands open
- Line 146: `toCents(Math.min(stack, openSize))` — VPIP-threshold hands open

**Postflop sites (8):** swapped `Math.trunc(... * 100) / 100` and missing-rounding sites for uniform `toCents(...)` wrapping on bet/raise amount outputs. Lines 175, 178, 182, 192, 196, 208, 215, 223.

## Deploy status

| Layer                              | Status                                                     |
| ---------------------------------- | ---------------------------------------------------------- |
| Server code fix in `HorseLogic.ts` | ✅ committed to CA repo main                               |
| Activation in production engine    | ⏳ pending Hetzner redeploy (`./server/deploy-hetzner.sh`) |

Until redeploy, horses keep emitting sub-cent amounts into `hand_history.actions`. No financial loss because the engine's pot arithmetic uses the same amount end-to-end — a horse raises 5.007319 and the pot has exactly 5.007319. The issue is _audit integrity_ and _Bible V8 §2.6 compliance_.

## Verification plan

Post Hetzner redeploy, run:

```sql
SELECT COUNT(*) FILTER (WHERE (elem->>'amount')::numeric * 100 != FLOOR((elem->>'amount')::numeric * 100)) AS sub_cent_actions,
       COUNT(*) AS total_actions
FROM hand_history, jsonb_array_elements(actions) elem
WHERE created_at > '<redeploy-time>';
```

Expect: `sub_cent_actions = 0` for all rows created after redeploy. Pre-existing rows retain sub-cent amounts; that's historical, not a regression.

## Related

- Bible V8 §2.6 — Pot object integer-cent arithmetic
- BUGs 008-019 — all prior silent-failure bugs this session

## Lesson

Twelfth silent-failure bug this session. Theme: every random-numeric output that lands in a financial audit row needs a rounding discipline at the source. Not at the consumer. `toCents` helper is cheap to add and makes the invariant visible to every future reader.
