# tests/a-bomb-hand-cannot-commit-without-its-award-units.law.test.ts

A bomb-pot hand that distributes chips cannot commit without award units summing to the pot: constraint trigger `zz_ca_bomb_hand_keeps_its_award_units` on `hand_history`, DEFERRED to commit, attached by `20260906143315` once the engine wrote both in one transaction (PR #3272). Pins the deferral, the guarded DDL, the self-proving probes, and that nothing in `server/src` sets constraints IMMEDIATE (Dan, 2026-09-06: code fixes, not sweeps).
