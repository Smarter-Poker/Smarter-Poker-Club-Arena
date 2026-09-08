# 2026-09-08 - The horse claim shipped onto a path the engine does not call

Migration `20260908043830`, applied and registered. This is a correction to `20260908024742`, written the same night by the same agent.

## What happened

`20260908024742` built ruling 3's horse claim into `record_daily_challenge_event_serialized_body`, and a rolled-back probe proved it: a horse completed a challenge and was paid inside the same transaction. The probe was right about the mechanism and wrong about the path. The engine calls the **six-argument** `record_daily_challenge_event(p_user_id, p_event_key, p_amounts, p_magnitudes, p_values, p_occurred_at)`, which carries its own completion UPDATE inline and never touches the serialized body.

Measured an hour after that migration: **733 challenges completed on the live path** (58 in the 04:00 hour, the most recent at 04:27), **0 rows claimed, 0 `CH3:horse_claim_failed` incidents**. A feature that neither worked nor complained - the shape CLAUDE.md 10.86 exists for, written by the agent that had spent the night fixing other people's versions of it.

The `ca_patch` overload assertion did not catch it, and could not have: the function it patched genuinely has exactly one overload. It is simply not the one that runs.

## The fix

The same loop, unchanged, at the end of the six-argument function. Both paths now carry it; a claim that has already happened is a no-op because the loop only selects unclaimed rows.

The migration also asserts, at apply time, that **no function completes a challenge without claiming for a horse**:

```sql
WHERE p.prosrc LIKE '%completed = (u.progress%'
  AND p.prosrc NOT LIKE '%claim_daily_challenge_serialized_body%'
```

A third completion path added later cannot silently skip the claim.

## Verified live, not just probed

- Probe (rolled back): the six-argument path claimed, balance 0 -> 192, equal to the 192 journalled.
- **Production, one minute after apply**: 1 completion -> 1 claim, 145 diamonds, 0 failures, and `fn_ca_mint_supply('diamonds')` = `sum(profiles.diamonds)` = 1,023,672 on both sides of the move.

## The lesson, written down

An overload count of one proves a function is **unique**, not that it is **used**. Before patching a body, ask what calls it (`SELECT proname FROM pg_proc WHERE prosrc LIKE '%<the body>%'`). After applying, ask the **data** whether the new behaviour happened - a probe answers "the mechanism works", and only a live counter answers "it ran".
