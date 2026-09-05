# Club Operations Phase 7 gate: what the deep dive found

Dan's standing gate before phase 8: verify everything phase 7 built is fully
built, coded, wired in and tested, and check for bugs, gaps, stubs, errors,
regressions or wiring issues anywhere and everywhere.

It found four things. Two of them were mine, one of them I caused during the
gate itself, and the fourth had been sitting in production for a day.

## 1. Three SECURITY DEFINER functions answered a caller with no account

The estate already owns the check that finds this -
`scripts/ci/audit-live-definer-exposure.mjs` - and it runs in
`schema-manifest-refresh.yml`, a scheduled workflow. Running it by hand against
production was the first thing this gate did, and it was **red, with three
findings**.

Proved with nothing but the publishable key. No session, no user:

```
POST /rest/v1/rpc/fn_ca_player_restricted       200  false
POST /rest/v1/rpc/fn_ca_player_restriction_for  200  {"id":null,"user_id":null,"scope":null,
     "reason_code":null,"reason_note":null,"status":null,"applied_by":null,...}
GET  /rest/v1/ca_player_restrictions            200  []
```

The table is safe - RLS on, no policy, so a direct read returns nothing to
anybody. The definer helpers were the way around it, and
`fn_ca_player_restriction_for` **returns the whole moderation row** - reason
code, reason note, who applied it, when it expires - for any user id a stranger
cares to type. Nothing leaked today only because the table has no rows yet. The
first time an operator restricts a player, that record was public.

The third, `fn_club_member_count`, is a different mistake and worth naming
separately. Its own migration says plainly what it wanted:

```sql
REVOKE ALL ON FUNCTION public.fn_club_member_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_club_member_count(uuid) TO authenticated, service_role;
```

That REVOKE names PUBLIC and only PUBLIC, and **revoking PUBLIC does not remove
a direct grant to `anon`**. An earlier definition had granted anon outright, so
the intended fix read as done and changed nothing. It is the mirror of the trap
the audit prints in its own guidance, the other way round.

`20260905073311` closes all three. Nothing legitimate lost access: the only
caller of either restriction helper - repo, client or engine - is
`fn_ca_refuse_restricted_entry`, the trigger function behind the three seat and
tournament guards, and that function is itself SECURITY DEFINER owned by
`postgres`, so its nested calls never consult the caller's grant. Proved rather
than asserted: with the helpers revoked from `authenticated`, an INSERT into
`table_seats` as `authenticated` now reaches the **RLS check** (42501 on the
policy), which it can only do after every BEFORE trigger has run.

After: all three answer 401 / 42501, and the audit is green -
`anon-readable functions: 7 (0 new)`.

## 2. The live edge grows all day, and I measured it at four in the morning

This is the one worth reading twice.

`fn_ca_rake_by_agent` measured **490-983ms at 03:55 UTC**, and
`ca_rake_snapshot` answered the browser in **591-1,157ms on every range**. Those
numbers are in phase 7's changelog and they were true.

The same calls, same club, nothing changed, at **07:37 the same morning**:
**3,402ms**, and `ca_rake_snapshot` back to a **500 after 8,155ms**.

Nothing regressed. The live edge is the part of the window the daily rollup has
not sealed - which is today - and today gets bigger every hour:

```
2026-09-01     9,288 attribution rows    175 players
2026-09-02    77,619                     267
2026-09-03   328,535                     257
2026-09-04   185,928                     237
2026-09-05    38,598  (07:37, still open) 174
```

Bounding the scan to one day, which is what `20260905052500` did, is only a fix
while that day is small. A busy day is a third of a million rows. The panel
would have healed every morning and failed every evening, which is worse than
failing outright because it looks like somebody else's fault.

**A MEASUREMENT TAKEN AT 04:00 IS NOT A MEASUREMENT OF A SYSTEM THAT IS USED AT
20:00.** Phase 7 already learned that a cold path measured warm reads as fixed;
this is the same lesson with a clock instead of a cache.

The fix is what phase 6 gave the club-level figure: `ca_club_rake_daily_user`,
per club, day and player, in **integer cents** (the read it replaces rounds each
row to a cent and then sums, and accumulating that in `numeric` would be a
different number), kept exact by three statement-level triggers on
`rake_attributions` - the table the sealed days are themselves built from, so
the two halves remain one number by construction.

Two migrations, because only one half needs a lock:

- `20260905073943` - the table, the two writers, the backfill. No lock, no
  behaviour change: nothing reads the table yet.
- `20260905074228` - the three triggers and the read, together in one
  transaction, **applied inside the 07:55 UTC maintenance freeze**, because
  `CREATE TRIGGER` holds a SHARE ROW EXCLUSIVE lock on `rake_attributions` and
  that table takes a row for every player in every raked hand.

The order is not arbitrary. A read that switched to the rollup before the
triggers existed would lose every hand raked in between, silently.

Measured from a browser session afterwards:

```
                   before (07:37)        after (07:58)
ca_rake_snapshot   500 after 8,155ms     200 in 694-724ms, month and year alike
fn_ca_rake_by_agent      3,402ms         ~230ms
```

and the rollup agrees with the attributions to the cent on every day, including
the one being written to while the query ran:

```
2026-09-01   4,817.00      4,817.00
2026-09-02  53,967.39     53,967.39
2026-09-03 189,745.69    189,745.69
2026-09-04  98,466.63     98,466.63
2026-09-05  10,225.37     10,225.37   (open, triggers writing)
```

### The off-by-one that the comparison caught

Old and new were compared under a single REPEATABLE READ snapshot across seven
parameter shapes before anything shipped. Six agreed. **A range ending
yesterday did not** - and that is the one range the change should not touch at
all.

The rollup is read by DAY, and I had written `du.day <= date_trunc('day',
v_to)::date`. `v_to` is either a midnight - ask for a range ending yesterday and
it is TODAY's midnight - or `now()` itself. The inclusive form got the second
case right and the first wrong, and **put today's rake into a report for
yesterday**. It reads `du.day::timestamptz < v_to` now, which is what the
timestamp range it replaced always meant.

A comparison that only exercised the ranges the change was aimed at would have
passed.

## 3. A probe of mine ran outside a transaction and committed

Section 11.5 rule 1 says a money path is probed inside a transaction you roll
back, and warns that a transaction does not span two Supabase MCP calls. This
was the psql version of the same failure and it is worth writing down.

The dry run was built by string-replacing `BEGIN;` in a copy of the migration.
The replacement did not land where I thought, so the statements ran with no
transaction open - psql said so, twice, in warnings I did not read:

```
WARNING:  SET LOCAL can only be used in transaction blocks
```

Every statement auto-committed. **The new read went live with no triggers behind
it**, so `fn_ca_rake_by_agent` was reading a rollup that nothing was keeping
current: for about four minutes, today's per-player rake was frozen at the
backfill.

It was found within those four minutes by diffing the live `prosrc` against the
migration file - the diff was two blank lines, which is not what a rolled-back
probe looks like - and the previous read was restored immediately, with an
assertion that refused to commit unless the attribution-scanning body was back.
The real change then landed properly in the freeze.

**The lesson, stated so the next agent gets it for free:** a probe that builds
itself by editing SQL text must PROVE it is in a transaction, not assume it.
`SET LOCAL can only be used in transaction blocks` is not noise; it is the
probe telling you it has already committed.

## 4. A PostgREST reload window makes a 230ms read look like an eight-second timeout

Twice in this phase, browser calls returned 500s at ~8s while the same function
measured in the hundreds of milliseconds in psql at that moment, and were fine
sixty seconds later. Both times the cause was the `pgrst_ddl_watch` schema
reload described in CLAUDE.md section 2 - ~28 seconds on this database - fired
by a migration that had just been applied.

**A timing taken inside the reload window is not a measurement, and neither is
the 500 beside it.** It is the mirror of measuring a cold path warm: the same
mistake in the other direction, and both were made here in one night.

## Also found, and NOT fixed here, because it is not phase 7's to fix

**165 of the 657 migrations recorded since 2026-09-01 have no file in this
repo.** They were applied through the Supabase MCP, which records a row in
`schema_migrations` without writing anything to `supabase/migrations/`. That is
how the two restriction helpers above came to be live, granted to anon, and
declared nowhere - I could not find their migration because there isn't one.

Both of the offending versions are recorded (`20260904150000
ca_player_360_and_restrictions`, `20260904183000
ca_the_restriction_guard_can_actually_be_reached`) and neither file exists. It
is an estate-wide gap, it needs a decision about direction rather than 165 files
written by an agent guessing at intent, and it is raised here with the number
attached.

## Verified

- Every phase 7 migration applied AND recorded, and the live function bodies
  still carry every marker they shipped with (13 checks against `prosrc`).
- `check-migrations-applied`, `check-definer-authorization`,
  `audit-live-definer-exposure`, `check-discarded-read-then-write`,
  `check-bus-wiring`, `check-ui-text`, `check-title-case`,
  `check-painted-text-case`, `check-no-orphaned-work`, `check-no-skip-markers`:
  all green.
- The only caller of each function phase 7 replaced, asked of `pg_proc` rather
  than assumed: `ca_rake_snapshot` for the breakdown, the report itself for the
  bomb pot catchup, nothing else.
