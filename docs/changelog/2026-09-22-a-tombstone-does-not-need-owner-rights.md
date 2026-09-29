# A tombstone does not need owner rights, and a reviewed decision has to be written where the reader looks

2026-09-22 / 2026-09-23 UTC

Two audits were red on `main` and both were about the same sentence: a
`SECURITY DEFINER` writer is reachable from a browser. They were not about the
same function, and only one of them was about a privilege anybody actually
held.

## What was named

**`Telemetry Exposure`** (run 35785525756), reading
`public.fn_ca_browser_reachable_telemetry()`:

| routine                                             | volatility | reached by    |
| --------------------------------------------------- | ---------- | ------------- |
| `fn_ca_new_tournament_is_unlimited(p_config jsonb)` | volatile   | authenticated |
| `fn_cashout_approve(uuid, text, uuid)`              | volatile   | authenticated |
| `fn_cashout_release(uuid, text, uuid)`              | volatile   | authenticated |

**`Schema Integrity Audit`** (run 35799265680), reading
`public.fn_definer_exposure_audit()`:

`fn_shared_bonus_replay(p_share_id uuid)`, executable by `anon`, read-only.
`anon-executable writers` was `0`, which is where it has to stay.

## Was any of it a real exposure? No, and the reason matters in each case

Two names look alarming and are not. `fn_cashout_approve` and
`fn_cashout_release` sound like a player approving and releasing their own cash
out. Their entire body, read from `pg_proc` before anything was decided, is:

```
BEGIN RAISE EXCEPTION 'cashier_v2_intent_required' USING ERRCODE='22023';END
```

`md5(prosrc) = aaf5c377a2a6b0e13ac95b5f11366bd3`, identical across all three
cashier tombstones. They were retired in favour of the v2 intent route on
2026-09-14 by
`supabase/accounting/weekly-v3/components/20260914164700_cashier_cashout_documents_share_the_existing_invoice_authority.sql`.
They read no table, write no row and move no chips. **Nothing was reachable,
for any length of time, that could do anything.** A caller got an error telling
it which route to use, and that is all it ever got.

What was true is smaller and still worth fixing: a function whose whole body is
a `RAISE` does not need to run as its owner. The `SECURITY DEFINER` on these
three is a leftover of the `CREATE OR REPLACE` that retired them, and the four
sibling tombstones written in the _same statement block_ -
`fn_approve_cashout_atomic`, `fn_cancel_cashout_atomic`, `fn_cancel_cashout`,
`fn_request_cashout` - carry no `SECURITY DEFINER` at all. The attribute was the
only reason these appeared on an operator-console report.

## What changed

Migration `20260923031831_a_tombstone_does_not_need_owner_rights_and_the_admission_pre.sql`,
one transaction, applied once at 03:23 UTC, outside the `:50-:03` break window.

1. **`ALTER FUNCTION ... SECURITY INVOKER`** on `fn_cashout_request`,
   `fn_cashout_approve` and `fn_cashout_release`. The privilege is taken away
   rather than an exception being recorded, so they leave the report on their
   own merits. `authenticated` **keeps** `EXECUTE` on purpose: a stale client
   should still receive `cashier_v2_intent_required`, which names its
   replacement, rather than a bare permission error that names nothing. `PUBLIC`
   and `anon` held nothing here and were given nothing.

   `fn_cashout_request` was not on the report. It escapes only because the word
   `club` inside `p_club_id` trips the identity-argument filter in
   `fn_ca_browser_reachable_telemetry()`. Leaving it definer would have left the
   identical latent finding standing behind a naming accident.

2. **An allowlist row for `fn_ca_new_tournament_is_unlimited(jsonb)`**, which
   genuinely needs both halves, with the reason read from rows rather than
   assumed:
   - It must stay `SECURITY DEFINER`. `fn_ca_lock_mtt_admission_contract()` and
     `fn_ca_is_new_mtt(jsonb)` are granted to `postgres` alone, so as an invoker
     it would fail for every browser role.
   - `authenticated` must keep `EXECUTE`. Two **`SECURITY INVOKER`** trigger
     functions on `public.tournaments` call it -
     `tournaments_creation_guard` -> `fn_tournaments_creation_guard()` and
     `tournaments_short_formats_never_break` -> `fn_short_formats_never_break()`
     - and an invoker trigger runs as the role doing the `INSERT`.
       `authenticated` holds `INSERT` on `public.tournaments`. Revoking here would
       not close a console; it would fail every logged-in tournament creation with
       "permission denied for function". That is precisely the outage shape
       `check-telemetry-exposure.mjs` records for 2026-09-06.

   It reads no row of anybody's data: it is a boolean over a config the caller
   already holds, plus the platform's own admission contract, under a **shared**
   advisory lock.

   `public.fn_ca_browser_reachable_telemetry()` now returns zero rows.

3. **`fn_shared_bonus_replay` recorded in `reviewedAnonReaders`** in
   `scripts/ci/definer-exposure-baseline.json`. This is a public bonus replay
   link where the random share uuid IS the capability, created only by the
   authenticated owner of a settled game. No identity, wallet, club, entry id,
   seed or unshared game is returned, and it holds no write capability.

## The cause of the recurrence, and what now stops it

The `fn_shared_bonus_replay` decision **had already been taken, properly, and
written down twice** - by migration
`20260919153418_public_bonus_replay_has_an_explicitly_public_reader.sql`, into
`public.ca_browser_definer_allowlist` and into the `anonPublicSurface` block of
`scripts/ci/definer-authorization.allowlist.json`. It was never copied into
`reviewedAnonReaders`, which is the only one of the three lists that the live
audit reads.

So the branch gate was green, production was correct, and the daily audit failed
every run from 2026-09-20 onwards on a question that had been answered on
2026-09-19. Three lists that must agree, and nothing comparing them: the same
shape CLAUDE.md 10.84 records for the monitoring rules, in a new place.

The database list cannot be read from CI, so
`tests/live-definer-exposure-audit.test.ts` now pins the two that can be: every
name in `anonPublicSurface` must also be in `reviewedAnonReaders`, with a reason
of its own rather than a cross-reference. It only ever demands more writing
down, never less, and it fails on the branch that introduces the gap instead of
in a daily job the next morning.

## Deliberately left alone

- `get_current_settlement_period` stays in `reviewedExceptions`. The audit
  prints "the baseline can shrink" for it, which is advisory and not the
  failure; shrinking another task's entry is not this repair.
- The two entries in `reviewedAnonReaders` flagged for Dan on 2026-08-31
  (`get_public_profile_by_username` returning `diamonds`, and
  `fn_club_leaderboard_period_v2` taking any club uuid) are product decisions
  already raised, and are untouched.
- `spatial_ref_sys` is owned by `supabase_admin` and still cannot be fixed from
  here, exactly as its baseline entry says.
