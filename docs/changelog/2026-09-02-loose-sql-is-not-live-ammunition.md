# Loose SQL in `supabase/` is not live ammunition

2026-09-02. The second audit pass after phase 7 of the agent credit and
promotion lifecycle. Phase 7 dropped four objects and repointed every surface
that read them; the first audit pass swept the client, the API routes and the
engine. This pass swept the one place neither of them looked: the SQL sitting
loose in `supabase/`, beside the seeds, **outside `supabase/migrations/`**,
where nothing versions it, no CI check reads it, and the next agent to open the
folder finds it and runs it.

Everything phase 7 shipped was re-verified against production first, and all of
it holds. What follows is what was still wrong.

## What was verified, before anything was changed

| Check                                                      | Result                                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Four dropped objects absent from production                | absent                                                                                  |
| `commission_records`, `commission_history` tables          | gone                                                                                    |
| `agents.pending_commission` column                         | gone                                                                                    |
| Functions naming a dropped object                          | 4, all in comments explaining the removal                                               |
| Phase 7 migrations recorded in `schema_migrations`         | all 5                                                                                   |
| `agent_commissions` RLS: agent reads own rows              | present, matches the realtime filter                                                    |
| `agent_commissions` in the `supabase_realtime` publication | yes (the bug phase 7 fixed has not come back under a new table name)                    |
| Accrual still running after the definer lockdown           | 3,387 rows / 1,332.92 in the last hour                                                  |
| Claim path, probed and **rolled back**                     | 1,107 rows, 434.95; bank −434.95, wallet +434.95, **conserved 0.00**, 2 ledger rows     |
| Claim path touches `credit_used`                           | no — rakeback still goes on top of squaring up                                          |
| PR #2541 published                                         | prod SHA `da32c5c1` serves a bundle built from CA `c8f4ce79`, which contains `a3d422fb` |

## 1. A file whose name is a command, loaded with live rounds

`supabase/APPLY_NOW_consolidated_realtime.sql`, dated 2026-03-14. Nothing in
the repo references it. Its name references itself.

Measured against production on 2026-09-02, it was **not** already applied: of
the 38 tables it adds to the `supabase_realtime` publication, 16 were already
published, 9 no longer exist, and **13 would still be added**. One of those 13
is `hand_history` — 3.6 GB, ~221,000 rows a day — so running the file would
have started streaming every hand insert on the platform through the WAL
decoder to realtime subscribers.

And each of the 13 is a DDL statement outside a transaction. Each fires
`pgrst_ddl_watch`, and each reload takes ~28 seconds on this database. That is
the precise shape of the 2026-08-31 PGRST002 outage that 503'd up to 28% of
live traffic, including seating and dealing — the outage CLAUDE.md's binding
"Production DDL policy" was written to prevent, whose first rule is that all
the DDL for one change goes in ONE transaction in a numbered migration.

Deleted.

## 2. A file that re-creates what phase 7 dropped, against columns that do not exist

`supabase/atomic_rake_increments.sql`. Four separate faults, any one of which
is enough:

- it re-creates `increment_agent_rake`, dropped by phase 7, writing
  `agents.rake_generated` — **that column does not exist**;
- it replaces `increment_rake_generated`, which has three real overloads live
  in production, with a body writing `club_members.rake_generated` — **that
  column does not exist either**;
- it ends with `CREATE POLICY IF NOT EXISTS`, which **is not valid PostgreSQL
  in any version**, so the file cannot run to completion regardless;
- that policy is `FOR ALL USING (TRUE) WITH CHECK (TRUE)` on
  `financial_alerts`, under a comment that says "Only admins/service roles can
  manage alerts". It says the opposite of what it does.

Deleted. This is the precedent CLAUDE.md section 1.3 set when it deleted
`scripts/antigravity-deploy.sh`: a file the rules name as forbidden, sitting
where an agent will find it, is a trap. The rule survives as a check.

## 3. Three seeds and an inspector still writing a dropped table

`run_seed_v2.mjs`, `seed_jaqk_part3_financial_social.sql`, `verify_seed.mjs`
and `inspect_schema.mjs` all still named `commission_records`. The two seeds
would now fail outright on the insert; the other two would report a table that
is gone.

They are repointed at `agent_commissions` rather than deleted, because the
point of seeding commission rows is that a freshly seeded dev database shows an
agent dashboard with something on it. The ledger is keyed by
`(club_id, user_id)` rather than `agents.id`, and the seeded agents map
cleanly — `d0…01 → …1103`, `d0…02 → …1104`, `d0…03 → …1105`, all in club
`a0…01` — so the same rows survive with the same amounts and rates. They are
seeded with `settled_at` NULL, because nobody has claimed them: that is what
the Records tab renders as Unclaimed and what `fn_agent_claim_commission` pays.

## The law

`tests/loose-sql-is-not-live-ammunition.law.test.ts`, registered in
`docs/LAWS.md`. Three pins, all of which fail on current `main` before this
change and pass after:

1. the two deleted files stay deleted, and no replacement announces itself with
   an `APPLY_NOW` / `RUN_NOW` style name;
2. no loose file in `supabase/` carries DDL — `ALTER PUBLICATION`, `CREATE OR
REPLACE FUNCTION`, `CREATE POLICY`, `ALTER TABLE`, `DROP …`, `CREATE
TRIGGER`. After this change there are zero exceptions, so the law needs no
   allowlist;
3. nothing loose in `supabase/` names `commission_records`,
   `commission_history`, `pending_commission` or `increment_agent_rake` outside
   a comment, and the seeds write `agent_commissions` unclaimed.

## What I did not change, and why

`fn_agent_unsettled_commission` still answers for any user id to any
authenticated caller. That was recorded as open at the end of phase 7 and it
stays open: the naive fix — restricting it to `auth.uid()` — breaks
`fn_club_set_member_role`, which calls it as part of the report a club owner
gets when demoting an agent. Closing it properly means splitting the caller's
own read from the owner's read, which is a change to the demotion path and
belongs in its own PR rather than riding along on an audit.

One state worth knowing about, found while picking a probe candidate and not
caused by anything here: club `fade0000-…-0001` owes 311.84 of unclaimed
commission across 408 rows, has a chip treasury of 0.00, and the agent it owes
has no `club_members` row in it. A claim there will refuse for insufficient
treasury, correctly. It is a data condition, not a code fault.
