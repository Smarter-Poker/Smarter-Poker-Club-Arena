# tests/a-banned-character-must-not-reach-the-database.law.test.ts

Dan banned the m bar on 2026-08-20 and repeated it on 2026-08-31: "remove any
and all m bars as they are banned from use." Five gates enforced it by that
morning and every one of them walked `src/`, so nothing could see the copy the
DATABASE serves: a Postgres function hands its RAISE message, and its jsonb
`{'message': ...}`, straight to the client, which toasts it verbatim, and 120
public functions were serving a banned character while all five gates reported
OK. Migration 20260831202752 rewrote them and left
`fn_ca_banned_copy_characters()` behind so CI could ask production directly;
`scripts/ci/check-db-copy.mjs` reads it and Cron Health fails the run on a
finding. That gate then stayed red from 2026-09-10 to 2026-09-19 on one
finding: `fn_spin_draw_and_settle_atomic`, a comment in its body reading "and
would be refused there <banned> a separate, rare (0.01%) defect", which
arrived with
20260910034412_spin_draw_gate_reads_zero_as_undrawn_and_stamps_the_row.sql. No
player read it, because it is a comment rather than a message; what it cost was
nine days of a red gate, which this tree's own words call the same blind spot
as no gate at all. It arrived unchallenged because the source gates walk
`src/`, `public/` and `server/src` and nothing walks `supabase/migrations`, and
a migration is the one way copy reaches a function body: the one door with no
lock on it. Migration 20260919145853 cleans the live database by finding every
offending function rather than naming the one somebody noticed, refuses past
five rather than rewriting live bodies unattended, keeps the checker's
exemption from its own rule so the gate cannot disable itself, and asks
`fn_ca_banned_copy_characters()` in the same transaction rather than trusting
its own predicate. This law is the other lock: from 20260911 onward no
migration may carry one of the four characters, written as `chr(8212)` when a
migration genuinely needs to name one, with `-- dash-ok: <why>` for the single
real exception, a migration that defines the checker itself. It binds forward
because 609 of the 3,169 migrations written before the cutoff carry one, and a
rule that fails on history gets switched off.
