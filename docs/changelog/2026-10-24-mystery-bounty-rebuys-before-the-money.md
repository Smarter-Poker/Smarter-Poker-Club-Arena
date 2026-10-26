# Mystery-bounty events accept rebuys before the money

Found while fixing "276 entries and 9 rebuys" (see
`2026-10-24-horses-rebuy-75-percent-and-bounty-rebuys-stop-colliding.md`).

## What was measured

Eight Union / Evening Mystery Bounty events with rebuys on 22-23 October:
1,172 busts inside the rebuy window, **zero rebuys**, for horses and humans
alike. Each attempt was refused with `Atomic bounty rebuy claim refused:
{"mode": "mystery_pre", "claimed": true, "obligation_id": null,
"bounty_blocked": "mystery_bounties_start_in_the_money"}`.

## Root cause

Before activation the bounty claim correctly records the bust and writes no
obligation: the head stays in the bounty pool as residual, the same rule an
ordinary pre-money mystery elimination follows. The rebuy step
(`fn_ca_settle_bounty_rebuy_generation_v1`) then demanded an obligation id, and
`process_tournament_rebuy` demanded a settled, marked obligation in two places.
A case with nothing to settle could never pass.

## Fix

Migration `20261024075911_a_mystery_rebuy_before_the_money_has_no_head_to_settle`:

- the rebuy step returns `no_bounty_head: true` only for that exact claim
  answer on a mystery event whose entry carries no head; a live head is refused;
- the rebuy door sets `v_no_bounty_head` only from that exact answer, and only
  then lets its two obligation checks pass without an obligation. Every other
  part of the atomic proof is unchanged.

Patched by exact anchors (each verified unique on production) with an md5
precondition on `process_tournament_rebuy`. The rebuy step half was replayed
against the exact live body in a throwaway PostgreSQL: it accepts the pre-money
answer, refuses a live head, and still refuses every other shape.
`process_tournament_rebuy` was not executed (its body drives the whole money
core). Both patched bodies, built by these exact replacements from the live
definitions, were compiled on production as `pg_temp` copies inside one
self-aborting DO block (CLAUDE.md 11.5): `PROBE_OK both patched bodies compile`.
Nothing was committed.

## Damage already done

None to settle: every refused purchase rolled back whole, and each player was
eliminated through the normal door with the normal place and payout.

Pinned by `tests/a-mystery-rebuy-before-the-money-has-no-head-to-settle.law.test.ts`.
