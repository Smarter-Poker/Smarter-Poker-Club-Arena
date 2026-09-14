# The Rail Asks The Server Once

**2026-09-14** — Phase 6 of the ticker programme, and the phase that was
supposed to be "realtime instead of polling". It is not, because the first thing
the investigation found was that realtime on this platform mostly does not work,
and the second was that the poll it was meant to replace was fetching 1,322 rows
to render one line.

---

## 1. 105 of 115 realtime subscriptions can never fire

Before adding a `postgres_changes` subscription for the ticker I checked what
the database actually publishes. Measured against production:

```sql
SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
-- club_members, notifications, tournament_bounty_obligations,
-- tournament_deal_votes, tournament_manager_wakes
```

Five tables. `src/` at the same moment carried **115 `postgres_changes`
subscriptions, of which 105, across 62 files, name a table that is not one of
them.** Thirteen on `tournaments`. Seven on `tables`. Six on `table_seats`. Five
each on `tournament_players`, `clubs`, `agents`, `agent_commissions` and
`chip_transactions`.

Supabase does not error on this. The channel opens, the status callback reports
`SUBSCRIBED`, the handler attaches, and nothing ever arrives. No error, no
warning, no log line. The screen is stale forever and the only way to notice is
to sit in front of it waiting for an update that never comes.

**What shipped, and what deliberately did not.** This does not fix the 105.
`ALTER PUBLICATION supabase_realtime ADD TABLE tournaments` does not "switch
realtime on" — it switches on thirteen callbacks that have never executed in
production, simultaneously, on a live poker platform. That is a review per
subscriber and a migration per table, and it is Dan's call, not a line in a
ticker PR.

What shipped is the ratchet:
`tests/a-realtime-subscription-is-to-a-published-table.law.test.ts` scans `src/`,
reads the published-table manifest, and fails any subscription to a table
outside it. The existing 105 are quarantined by file and table — including the
counts, so a file with one dead subscription cannot quietly grow a second — and
a stale quarantine entry fails too, because it would wave the next one through.
Verified by adding a probe subscription on `tournaments`: the law went red and
named the file, and green again when removed.

For new work that wants server push, `realtime.send()` and
`realtime.broadcast_changes()` both exist on this database and need no
publication change. That is written down in the manifest.

## 2. Five queries, 1,322 rows, one line of text

The ticker ran five queries every thirty seconds, for every seated player:
registrations (200 rows), upcoming (25), overlays (25), an operational sweep of
`tournaments` (80) and new tables (10).

The sweep was the expensive part and the broken part. For a real three-club
member it **matched 1,322 rows** and took the eighty most recently `updated_at`
— a column with **no trigger maintaining it** — and the browser then filtered
that slice down to the rows that could actually speak:

| source               | could speak | candidates |
| -------------------- | ----------- | ---------- |
| registration closing | 2           | 1,028      |
| guarantee starting   | 3           | —          |
| result to report     | 72          | —          |

Three sources sharing one budget of eighty, ordered by a proxy for recency that
is not reliably recency. This is exactly the defect fixed in #4601, where a major
was crowded off the rail by five turbos, except **silent**: a bar with nothing on
it looks identical to a bar with nothing to say.

**`fn_get_ticker_feed`** does the filtering where the rows are. One round trip, a
row budget **per source**, and the real predicates instead of a wide slice
narrowed in a browser. Registration closing goes from 1,028 candidates to 2.

The club scope is derived from `auth.uid()` **inside** the function, so the
membership list no longer travels in either direction and a caller cannot ask
about a club it does not belong to — a strictly stronger version of the union
scoping guarantee, and `unionSurfacesAreSealed` now asserts that stronger form.
`is_registered` is resolved server-side, which removes the 200-row
`tournament_players` read entirely, and `foreign_club_name` arrives on the row
that needs it, which removes a second `clubs` read and the chance of the two
disagreeing.

**What deliberately stayed in TypeScript.** All copy, `lateRegEndMs()` and
`rankOverlayAnnouncements()`. Composing sentences in plpgsql would fork
`tickerMessages.ts` into a second implementation that the Title Case and em-dash
checks cannot see, and `lateRegEndMs` parses the blind structure and sums level
durations — logic corrected twice in August, which should exist once, in the
language that has the tests.

So the SQL ships a **provable superset** for registration closing instead.
`lateRegEndMs` takes the later of two candidates, so a row can only speak if the
minutes candidate is itself inside the five-minute window (computable exactly in
SQL) or the levels candidate exists at all (`late_reg_levels > 0 AND
current_level < late_reg_levels AND level_started_at IS NOT NULL`, bounded by
twelve hours). If the maximum is the minutes one, branch one matches; if it is
the levels one, branch two's conditions hold. Nothing that should speak is
excluded.

Every subquery was rehearsed read-only against production before the migration
was written, and the migration verifies itself: it calls the function as a real
member with every source off (every array must be empty) and every source on
(no array may exceed its own budget), and rolls back if either is untrue.

## 3. What "arrives when it changes" turned out to mean

Push was the wrong tool here twice over — the table is not published, and
`tournaments` carries engine writes that have nothing to do with the bar. The
poll stays, but it now costs **one round trip instead of five and at most a
handful of rows instead of ~340**, which was the actual complaint. Adaptive
intervals were considered and deferred: with the feed shrunk this far, the
remaining saving is one call per thirty seconds, and the change would have
invalidated sixteen recovery tests for it.

## 4. E2E, asserted on traffic

`tests/e2e/ticker-asks-the-server-once.spec.ts`, wired into
`post-deploy-e2e.yml`. It asserts on the **network**, not the DOM, because this
suite's own history is that 80 specs once ran green against a 404 page —
`expect(body).toBeVisible()` is true of every HTML response ever served. The spec
sits through a full poll interval and fails if the old fingerprint
(`tournaments?…club_id=in.(…)`, or any `tournament_players` read) reappears, or
if a membership list shows up on the wire. It runs after the deploy rather than
as a merge gate, which is the correct side of the publish: before it, production
still has the old code and the spec _should_ be red.

---

## Verified

- `tsc --noEmit`, ESLint (0 errors), Prettier, `check:title-case`,
  `check:painted-text` — all clean.
- Full suite, 4 shards: **20,382 tests — 20,380 passed, 1 skipped, 1 red**. The
  red is `engine-release-seal.law.test.ts`, which shells out to Python and needs
  `tomllib` (3.11+) against this machine's 3.9.6; it fails identically on a
  pristine `origin/main` worktree with none of this applied.
- Three repo guards caught this work and were satisfied properly rather than
  suppressed: the law registry wanted a `docs/laws.d/` entry, the reachability
  law correctly refused a file under `src/` that only a test reads (the manifest
  moved to `tests/helpers/`), and the production-spec law wanted the new E2E
  wired into the deploy gate.
- Retargeted rather than deleted: 20 tests across four files that pinned the old
  five-query shape now pin the same guarantees in their new home — including the
  registration-status casing (which moved into SQL, where a one-word slip is
  exactly as silent) and the union scoping.
