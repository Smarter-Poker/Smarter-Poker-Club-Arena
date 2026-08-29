# The latency scope reads the live variant, not a field the snapshot never had

**Date:** 2026-08-29
**Agent:** cowork-fable (scheduled verification run)
**Follow-up to:** #1731 (feat(brain): measure how long a horse takes to think)

## What production showed, first hour of the measurement

`horse_decision_latency` had exactly one scope after the 14:43 UTC deploy:

    scope=nlh  samples=14,326  mean=3.516ms  max=145.2ms

while `tables` said 58 of the 91 running tables were dealing PLO variants
(plo4 x28, plo6 x10, plo5 x10, plo8 x4, pineapple x4, short_deck x3) and had
dealt 1,707 non-NLH hands in the same window. Every plo6 decision — the one
with the documented 15ms budget that this instrument exists to watch — was
being relabelled `nlh` and averaged away. The exact failure the scope comment
warns about, caused by the line under the comment.

## Why

The call site read `(gameState as any)?.variant`. The horse snapshot built by
`buildHorseGameState` carries no `variant` field, so the read was `undefined`
on every single decision and the `?? 'nlh'` fallback swallowed it silently.
`activeHandVariant()` — introduced 2026-08-28 precisely so code reads the LIVE
hand's variant instead of guessing — was already in use eleven lines up, in
the pot-limit clamp.

## The fix

One line: `noteDecisionMs(this.activeHandVariant() || 'nlh', ...)`, plus a
source pin in `DecisionLatency.test.ts` so the scope can never quietly go back
to a field that does not exist.

## Also in this verification run

- Applied `20260829120000_lease_heartbeat_tells_the_truth_and_leases_get_reaped`
  to production via the Supabase MCP — it was authored in #1726 but never
  applied, which is what held #1726's CI red and its auto-merge parked.
- Resolved #1731's merge conflict against main (stale copies of the stake-band
  files on the branch; main's "band is EARNED" versions taken in full).
