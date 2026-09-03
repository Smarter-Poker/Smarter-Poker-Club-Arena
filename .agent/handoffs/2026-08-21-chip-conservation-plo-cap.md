# HANDOFF: chip conservation broken by the PLO pot-cap clamp

**Severity: CRITICAL.** Chips are being created and destroyed. This is the
worst class of bug a poker platform can have.

**Status:** blocking every Hetzner engine deploy since 2026-08-21 ~11:11 CDT.
The deploy gate is doing its job. **Do not bypass it** — shipping an engine
that fails chip conservation is worse than not shipping.

Written by the Cowork stats agent, which found this while verifying its own
deploy. It is **not** the stats agent's code and was deliberately not
guess-fixed: `HandController.performAction` was being actively edited by
another agent in the shared clone at the time, and blind edits to chip
accounting are how a bad situation becomes a worse one.

---

## What is failing

```
server/src/engine/ChipConservation.property.test.ts
  × conserves chips across 10000 randomized hands (fixed corpus from seed 1)
      → chip conservation violated on seed 276
  × explores 1000 previously untested hands
      → chip conservation violated on seed 78774001
```

Observed violations (from `StateVerifier`):

```
CRITICAL: CHIP_CONSERVATION — mismatch (in_hand):       expected 2000, got 2200  (+200)
CRITICAL: CHIP_CONSERVATION — mismatch (in_hand):       expected 2000, got 1900  (-100)
CRITICAL: CHIP_CONSERVATION — mismatch (in_hand):       expected 1000, got 1000.5 (+0.5)
CRITICAL: CHIP_CONSERVATION — mismatch (hand_complete): expected 2000, got 1700  (-300)
```

Both signs appear, so chips are being **minted** in some runouts and
**destroyed** in others. The `+0.5` strongly suggests a rounding path as well
as a structural one.

## Bisect — confirmed, not inferred

Run in a detached worktree so the shared clone was untouched:

| Commit                                      | ChipConservation        |
| ------------------------------------------- | ----------------------- |
| `e85aea040` (last successful engine deploy) | **4 passed**            |
| `2474d9367` (next engine commit)            | **2 failed / 2 passed** |

`2474d9367` = _"three binding table rules — PLO can never shove above the pot
(all_in was the one action skipping the cap), new cash players are never dealt
into the SB, and a sitting-out player is removed after 2 button passes or 5
minutes"_.

## Prime suspect

`server/src/engine/HandController.ts`, in `performAction`:

```ts
let effAction: ActionType = action;
let effAmount = amount;
if (isPotLimit && action === 'all_in' && bettingState.maxRaise !== undefined) {
  const allInTo = player.bet + player.stack;
  const capTo = this.state.currentBet + bettingState.maxRaise;
  if (allInTo > capTo + 0.005) {
    effAction = this.state.currentBet > 0 ? 'raise' : 'bet';
    effAmount = Math.round(capTo * 100) / 100;
  }
}

const validation = validateAction(effAction, effAmount, player.stack, bettingState);
action = effAction;
amount = effAmount;
```

Why this is the suspect rather than the validator:

- The matching `validateAction` change in `PokerEngine.ts` was read line by
  line and is **correct** — the `case 'all_in'` block returns `{ valid: true }`
  properly, so there is no switch fall-through.
- This clamp is the only change in that commit that **rewrites an action's
  identity and amount** after the caller has already decided it. A player who
  intended to shove is now a `raise`/`bet` with chips left behind, so
  `is_all_in` is not set and the side-pot / `totalInvested` bookkeeping takes a
  different path than the one the caller's chip math assumed.

### Specific things to check

1. **Does anything downstream still treat this player as all-in?** If
   `is_all_in` is set anywhere off the original `action` rather than
   `effAction`, the player is simultaneously all-in and holding chips.
2. **`Math.round(capTo * 100) / 100`** — every other money path in this engine
   is exact-penny (see `calculateRake`, which has its own note about
   `Math.trunc` under-collecting by 1¢). Rounding the cap _up_ hands the player
   a fraction of a cent that came from nowhere. That is almost certainly the
   `+0.5`.
3. **`player.bet + player.stack` vs `currentBet - toCall + playerStack`** — the
   clamp and the validator compute the player's committed amount two different
   ways. If they ever disagree (straddle, dead blind, ante, uncalled-bet
   refund) the clamp lets through an amount the validator would have rejected.
4. **The uncalled-bet refund.** `returnUncalledBet` decrements
   `totalInvested`. A clamped raise that is then uncalled takes that path with
   an amount the player never actually intended.

## How to reproduce

```bash
cd ~/Documents/Smarter-Poker-Club-Arena/server
npx vitest run src/engine/ChipConservation.property.test.ts
```

Both failing seeds are printed and are deterministic: **276** and **78774001**.
Reproduce a single hand from a seed before changing anything, so the fix is
verified against the actual failure rather than against a hunch.

## Definition of done

1. `npx vitest run` in `server/` is fully green (1004 tests).
2. The two named seeds are added as explicit regression cases, so this exact
   violation cannot return silently.
3. The Hetzner deploy workflow goes green and the engine actually ships.
4. **Do not** relax, skip, or reseed `ChipConservation.property.test.ts` to get
   past it. It is the only thing standing between a chip-minting bug and
   production.

## Already fixed, do not redo

The same commit also broke two guard tests, which were **fixture staleness,
not production bugs**. Both are fixed on `main` (`b280387d3`):

- `afkSitOutGuard.test.ts` — expected 2 occurrences of the gated sit-out
  exclusion in `ServerTableEngineBase`; there are legitimately 3 now, because
  `getSBSeatIndex()` builds the same roster as `getBBSeatIndex()`.
- `PendingAddOnIdleSweep.test.ts` — its `disconnectEngine` stub lacked
  `tickSitOutsAndCollectEvictions`, which `dealingLoop` now calls before the
  add-on sweep, so the loop threw before reaching the behaviour under test.

ChipConservation is the only remaining blocker.

---

## Merge note, 2026-08-21 (the agent that caused the bug)

Two of us fixed this independently, minutes apart, and the two fixes are now
merged rather than one overwriting the other:

- **`HandController.getAvailableActions`** — kept the OTHER agent's version.
  Mine only asked "is the jam over the pot cap?"; theirs PROBES the clamped
  action through `validateAction` and then also requires `canReopenBetting`.
  That second condition is the one mine missed: once `performAction` clamps a
  pot-limit shove it is a RAISE, so TDA 44 / Bible V8 §4.14 applies to it, and
  with antes in play the clamped raise can land below a full raise and be
  illegal for a player who has already acted. Theirs is the correct fix.

- **`HorseLogic.legalize`** — kept mine (`capPotLimitJam`). The engine no longer
  offering an over-cap jam does not stop the horses from CHOOSING one; that
  function had its own short-circuits to `all_in` at >=92% and >=95% of stack,
  plus a closing `return d; // ... all_in are always legal here` that the cap
  had quietly falsified.

Both were needed. Verified together: server suite 93/93 files, 1004 tests green,
including both chip-conservation property tests.

I also force-pushed over six commits while resolving this (`git-safe-push.sh`
aborts a conflicted rebase and force-pushes by design). They were recovered from
the reflog and merged back in the same commit as this note — nothing was lost,
but that fallback is worth knowing about before running the script with a
divergent branch.
