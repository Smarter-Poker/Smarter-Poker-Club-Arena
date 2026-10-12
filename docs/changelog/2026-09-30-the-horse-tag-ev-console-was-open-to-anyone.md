# The horse tag EV console was open to anyone, and four others only looked it

**2026-09-30.** Two guards had been red for weeks saying a browser could execute
an unscoped SECURITY DEFINER routine. Both were right, about one routine. The
other four they named were not open; one of them could not have been seen to be
closed by the check that named it.

## What was actually reachable

`fn_ca_browser_reachable_telemetry()` returned five routines. Each was read in
full, with its ACL, its body, its callers in both repositories on `origin/main`
(Club Arena `7119d5722`, World Hub `1ccf3907c`), and its callers inside the
database, before anything changed.

| Routine                               | Reached by                    | What it could do                                                                                                                                              | Outcome                                                                         |
| ------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `fn_horse_tag_ev_significance(date)`  | PUBLIC + anon + authenticated | Reads `horse_review_rollup`; returns per-situation hand count, bb/hand, spread and z score for the horse fleet. Read-only; no wallet, seat or hole-card data. | **Closed.**                                                                     |
| `fn_ca_diamond_staff_books(text)`     | authenticated                 | The Diamond books, adjustments queue and receipts. Real money.                                                                                                | False positive: refuses a stranger on its first statement. **Criterion fixed.** |
| `fn_capability_available(text)`       | authenticated                 | One boolean: is a named capability deployed.                                                                                                                  | Must stay. **Allowlisted.**                                                     |
| `fn_diamond_arena_leaderboard_period` | authenticated                 | The Diamond Arena leaderboard.                                                                                                                                | Product surface. **Allowlisted.**                                               |
| `fn_platform_capabilities()`          | anon + authenticated          | The capability registry, read before login.                                                                                                                   | By design. **Allowlisted.**                                                     |

`anon_definers=1` in Production Integrity Audit was the same routine: the live
anon-executable set was 25 against a manifest of 24, and the one unaccounted
signature was `fn_horse_tag_ev_significance(p_since date)`.

## The one that was open

Its ACL was `=X/postgres` — the PUBLIC grant — plus explicit `anon` and
`authenticated`. **Revoking PUBLIC alone would have looked like a fix and would
not have been one**, because Supabase grants `anon` and `authenticated`
directly. All three went together, and `service_role` was left alone.

It was not a dormant handle. Probed as `anon` before the change it returned 21
live rows. It has no caller: zero references in `src/`, `server/`, `pages/`,
`scripts/` or `lib/` on `origin/main` in either repository, the only textual
reference anywhere being a frozen historical-schema fixture under
`scripts/ci/probes/`. Its only database caller, `fn_run_horse_daily_audit`, is
SECURITY DEFINER, so its inner call runs as the owner and never needed a browser
grant. The sibling the horse pages actually read, `ca_horse_tag_trends`, is
allowlisted and untouched.

Horses are players (10.5), and this was per-situation win-rate analytics about
them served to anyone who asked.

After the revoke, as `anon` and as `authenticated`:

```
anon          -> REFUSED 42501 :: permission denied for function fn_horse_tag_ev_significance
authenticated -> REFUSED 42501 :: permission denied for function fn_horse_tag_ev_significance
service_role  -> service_role OK, rows=21
```

## The one that was never open, and why the check could not tell

`fn_ca_diamond_staff_books` refuses a stranger before it reads anything — but
through a helper. `fn_is_platform_admin()` is what calls `auth.uid()`, followed
by `fn_caller_session_is_live()`. The criterion tested
`prosrc NOT ILIKE '%auth.uid()%'` and three siblings **against the routine's own
text only**, so every staff door that delegates its gate read as an open
console.

That blind spot was not new and it was not free. Measured before this change:
eleven browser-reachable definers gate themselves through `fn_is_horse_admin()`
or `fn_is_platform_admin()` without naming `auth.uid()` themselves, and **ten of
them already carried a hand-written allowlist row** — two of which say in their
own recorded reason that the owning migration should have carried it, and one
that it was added because "its absence turned the Telemetry Exposure check red
for every open PR". `fn_ca_diamond_staff_books` was about to be the eleventh row.

Adding a row is the workaround. The criterion now follows one level into a
helper that consults the caller, which is the fix (10.11). Nothing else about
the criterion moved: the four direct tests, the trigger-return exclusion, the
identity-argument rule, the PostGIS prefix rule and the allowlist lookup are all
unchanged, and all are pinned by the law.

## The revoke that would have been an outage

`fn_capability_available` looks like the easiest of the five to close. It is not.
The SECURITY INVOKER trigger `zz_tables_kill_pot_guard` on `public.tables` calls
it, and a SECURITY INVOKER trigger runs as the role doing the write.
`authenticated` holds INSERT and UPDATE on `public.tables`, so revoking would
have failed **every logged-in Kill Pot table creation** with "permission denied
for function" rather than closing a console.

This is the 2026-09-06 lesson one level over: that time it was four RLS policy
helpers, where a policy expression runs as the caller. This time it is a trigger.
The estate had already met this exact shape once — `fn_ca_new_tournament_is_unlimited`
carries the same reason for the same trigger-runs-as-the-writer rule on
`public.tournaments`. The migration asserts `authenticated` still holds EXECUTE
on it, so a later tightening pass cannot take it away quietly.

No RLS policy calls any of the five; `pg_policy.polqual` and `polwithcheck` were
searched for all five names and returned nothing.

## Before and after

|                                            | Before                                                             | After                      |
| ------------------------------------------ | ------------------------------------------------------------------ | -------------------------- |
| `fn_ca_browser_reachable_telemetry()` rows | 5                                                                  | 0                          |
| anon-executable definers in `public`       | 25                                                                 | 24 (manifest: 24)          |
| `fn_horse_tag_ev_significance` ACL         | `=X/postgres`, `anon`, `authenticated`, `service_role`, `postgres` | `postgres`, `service_role` |

## What is pinned

`tests/the-horse-tag-ev-console-is-not-a-browser-route.law.test.ts` fails if the
three revokes stop travelling together, if any later migration re-grants the
function to PUBLIC, `anon` or `authenticated`, if the one-level helper hop or any
of the four direct tests leaves the criterion, or if the allowlist lookup is
dropped. Its re-open assertion was checked against three re-grant spellings, and
against a legitimate `service_role`-only grant and a commented-out re-grant, so
it fires on the first three and stays silent on the last two.

The ten now-redundant allowlist rows were deliberately left in place: each
carries a written reason that is worth keeping, and removing them is not needed
for the criterion to be correct.

## Not done

No detector, cron, sweep or repair job was added (10.11, 10.12). The grants are
the fix; the guards are the existing readers and are now expected to find
nothing.
