# 2026-08-29 — Rake + BBJ: bug hunt, then hardened so it cannot regress

Dan: "CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR WIRING
ISSUES ANYWHERE AND EVERYWHERE... after you are done with the bug hunt,
harden the rake and bbj process collection and tracking so it can't regress
or break ever."

## The bug the hunt found

`finalizeRunout(skipDistribution)` — the RIT / already-distributed settlement
path — **had no pot-overage clamp**. `completeHand` and `computeRakeAndBBJ`
both clamped `rake + bbjFee` to the pot; this one did not. Harmless while the
drop only applied to 10BB+ pots; the moment the BBJ collection fix landed
(same day) a small RIT pot could be charged more than it held and MINT chips.

Verified not yet bitten: zero hands in all of production history have
`rake + bbj > pot`. Fixed before it could.

Root cause, both this and the 49%-underfunded-jackpot bug: **the pricing
arithmetic was hand-copied into three settlement paths.**

## The fix

One canonical pricer, `HandController.priceDeductions(flopSeen, pot)`, owning
the collection rule AND the overage clamp (BBJ yields first, then rake).
`completeHand`, `finalizeRunout` and `computeRakeAndBBJ` all route through it.
`bbjCfg.feeBB` is now multiplied out exactly once in the entire file.

## The hardening — four independent layers

1. **`server/src/engine/RakeBBJCollection.law.test.ts`** (14 pins): the drop
   is charged in a 1.5BB pot; never without a flop; never under 3 dealt; the
   fee does not scale with the pot; deductions never exceed the pot across
   eight pot sizes; BBJ yields before rake; one pricer, three callers, no
   `minPotBB`/`potInBB` anywhere in the file; and the 10BB PAYOUT floor still
   blocks a qualifying beat.
2. **`scripts/ci/check-rake-bbj-collection-law.mjs`** — a build gate, wired
   into `ci.yml` and `all-gates.sh`. Fails if anyone re-introduces a pot-size
   condition on a fee path, adds a fourth copy of the pricing, or changes
   `calculateBBJFee` back to `potSize`. **Proven by deliberately
   re-introducing the pot gate: exit 1 with the violation named, then exit 0
   on restore.**
3. **`fn_rake_bbj_invariants` / `fn_rake_bbj_audit`** (migration 20260829j) —
   seven production data invariants, audited hourly by pg_cron, one alert per
   cycle, critical when money is implicated. First run: zero violations.
4. **`tests/config/weightedContributedRake.law.test.ts`** — six added pins
   that the gate itself stays wired and the player-facing copy keeps stating
   collection and payout separately.

## Not changed

`detectBBJHit` / `detectBBJNearMiss` and the whole payout path: untouched.
Historical hands: not adjusted, not credited (Dan's explicit instruction).
