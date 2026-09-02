# The Agent's Books Tell The Truth

**Phase 7 Of 7, Agent Credit And Promotion Lifecycle. The Last One.**

Phase 6 built the path that pays an agent. Nobody had used it. This is the pass
over everything standing in front of that path, all of which was telling people
zero.

## What The Agent Saw

Production, 2026-09-01, the day after phase 6 shipped:

```
agent_commissions   988,530 unsettled rows   408,809.59 chips   114 agents
                    nobody has claimed yet

SHARK CLUB           owed 399,609.57   treasury 1,376,610.47   68 agents
Club JAQK            owed   8,499.76   treasury 1,051,788.71   43 agents
Midway Union         owed     607.05   treasury         0.00    19 agents
Deep Stack Society   owed      95.37   treasury    97,800.23   70 agents
```

And on the agent dashboard: **four zeros**.

`fn_get_agent_commission_summary` was a stub. Its entire body:

```sql
BEGIN
  -- STUB: underlying commission table "amount" column drift. Return zeros.
  RETURN QUERY SELECT 0::bigint, 0::bigint, 0::bigint, 0::bigint, NULL::timestamptz;
END;
```

That function fills Total Earned, This Week, This Month, Pending Payout and Last
Payout. It also returned `bigint`, which cannot carry the two decimal places of a
chip, and `RETURNS TABLE`, which reaches PostgREST as an **array** - so the
client's `summaryData.total_earned` was `undefined` before the zeros even got
there. Two independent reasons for the same 0.

The other tabs were furnished the same way:

| Surface                                | Read                           | Rows in it                                                                                   |
| -------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| Records tab, and its realtime listener | `commission_records`           | **0, ever** - and it is not in `supabase_realtime`, so the listener could not fire either    |
| Sub-Agents tab                         | `agents.pending_commission`    | a column **nothing writes**                                                                  |
| Club financials, "Agent Commissions"   | `commission_history`           | **0, ever**                                                                                  |
| World Hub agent leaderboard            | `commission_history`           | every agent ranked on 0 earnings                                                             |
| World Hub trends sparkline             | `get_daily_commission_summary` | asked that table for a column named `amount` that it does not have - **42703 at every call** |
| `fn_club_set_member_role`              | `agents.pending_commission`    | so a demotion reported "owed nothing" for 109 of the 114 agents who were owed something      |
| `fn_ca_gdpr_financial_precheck`        | `agents.pending_commission`    | so an account holding unclaimed commission could be **cleared for deletion**                 |

The last one is the one that could have cost somebody real money. The claim pays
`auth.uid()` and nobody else, so deleting the account is precisely what makes the
claim unrecoverable. It now blocks on the ledger, per club, and names the figure.

## The Settlement That Paid Nobody

548,987 rows carried `settled_at = '2026-08-20 17:18:22.456863+00'`. Every one of
them **the same instant**: 75 agents, 3 clubs, **256,765.50 chips**.

There is no `chip_transactions` row of any commission type in that window - or
anywhere in that table's history - and no `audit_trail` row between 16:00 and
19:00 that day. Nobody was paid. A bulk statement marked the debt settled and no
chips moved.

Dan, asked what should happen to it:

> "ITS RAKE BACK RIGHT? PAY IT OUT FROM THE OWNER ACCOUNT FROM THE CLUB BANK"

So the stamp is removed and the money is claimable again through
`fn_agent_claim_commission`, which debits the club bank for exactly what it
credits. **This migration moves no chips.** It restores a debt that was erased,
and the agent draws it the way phase 6 says they must - which also means Midway
Union's 122.35 waits for an owner to fund a bank holding 0.00, rather than being
paid out of nowhere.

The reversal is journalled in `ca_ledger_mutation_log`, not `audit_trail`:
`audit_trail.actor_id` is `NOT NULL` with a foreign key into `auth.users`, and
there is no human actor here. Inventing one to satisfy a constraint would put a
person's name on a migration's work.

## Why It Is Batched, And What Two Rehearsals Cost

Rehearsal 1: as one statement, **killed at exactly 120 seconds** by
`statement_timeout`, 548,987 rows in, nothing to show.

Rehearsal 2: batched at 20,000 - **killed at 120 seconds again**, four batches
in. `statement_timeout` applies to the `DO` block as a whole, not to each
statement inside it. And with no index on `settled_at` (the only one is partial,
`WHERE settled_at IS NULL`, which excludes exactly these rows) every batch paid a
full scan to find its next 20,000: **26 seconds each**, 28 batches to go.

Rehearsal 3: `SET LOCAL statement_timeout = '0'`, and the id set collected once
into a temp table and drained. **3 minutes 44 seconds**, complete.

On production it ran as **committed batches outside any transaction**, so nothing
was held open and it could have been stopped at any point. The migration keeps
the batched block, so a database that has not had it still gets it; against
production it finds nothing left and says so.

`CREATE INDEX` on 1.5M rows measured 12-17 seconds in rehearsal, and it holds a
lock that blocks every commission INSERT for all of it - which is inserts as
hands settle. Both indexes were built `CONCURRENTLY` beforehand, so the
migration's own `CREATE INDEX IF NOT EXISTS` is a no-op. It stays in the file so
a database built from these migrations still gets it.

## The Double Pay This Closes

`credit_agent_commission_from_rake` writes **both** an `agent_commissions` row
**and** `agents.weekly_rake_generated`, in the same call, as each hand settles.

The World Hub's `settle-period` close then computed commission a **second time**
from `weekly_rake_generated` and inserted it into `commission_records` as
`pending`, payable by staff through `pay_all`.

One piece of rake, two payable debts: one the agent claims, one staff pays. It
never fired - both tables were empty because every historical close 401'd or
stalled - which is the only reason this is a removal and not an incident.
Smarter-Poker-World-Hub#1187 removes that half and merges first; this migration
removes the tables it wrote to, so it cannot come back.

## What Else Went

Four functions that only ever touched the dead objects:

- `get_agent_commission_history` - selected `commission_history`. No caller.
- `generate_period_settlement` - a stub: _"commission_records.updated_at column
  drift"_. No caller. The plural `generate_period_settlements`, which the
  settlement dashboard does call, is a different function over `agents` and
  `agent_commissions`, and is untouched.
- `atomic_pay_agent_settlement` - **staff paying an agent**, decrementing the
  column nothing incremented. It contradicts Dan's phase 6 ruling and would have
  paid against a figure that was already wrong. Removed from
  `fn_union_money_path_check` (which treats a named function that no longer
  exists as a breach, in its own words) and from `guard_wallet_balance_write`.
- `increment_agent_rake` - **the only writer of `pending_commission` anywhere in
  the database**, and it has no caller. That is why the column froze at
  26,859.87.

## Evidence

Verified against production inside rolled-back transactions, with the migration
applied in the same transaction:

```
summary, largest agent (198,304 rows)   answers in chips, one club and all clubs
GDPR precheck, same agent               clear:false, names the club and the figure
role change, same agent                 reports unclaimed_commission from the ledger
promote -> fund -> send on credit       500 float, 700 sent, 200 drawn on credit
accrue -> claim                         bank -X, player wallet +X, conserved: 0
claim -> credit_used                    unchanged: rakeback goes on top, per Dan
downline figure                         definer function; RLS keeps rows private
```

24 law pins in `tests/the-agents-books-tell-the-truth.law.test.ts`. The one pin
this phase deliberately moved -
`a-demotion-closes-the-books` on `'pending_commission'` - moved with it in the
same commit, to `'unclaimed_commission'` read from the ledger, and got two more
pins beside it rather than being weakened.

And the proof that the file is what ran: `md5(pg_get_functiondef(oid))` for all
eight touched functions, captured before re-applying this file inside a
transaction that was rolled back, compared to after. Seven came back IDENTICAL.
The eighth, `fn_club_commission_accrued`, did not - the body applied through the
migration API was missing two comment lines the file carries, and a comment is
part of `prosrc`. `20260901133551` corrects it, and all eight are identical now.

## One thing left open, on purpose

`fn_agent_unsettled_commission(p_club_id, p_user_id)` is phase 6's, is SECURITY
DEFINER, is granted to `authenticated`, and asks nothing about who is calling -
so any logged-in member can read any agent's unclaimed total by user id. This
phase does not lean on that (the Sub-Agents tab uses
`fn_agent_downline_commission`, which answers only for the caller's own
downline), but it does not fix it either.

It is left alone deliberately. The obvious tightening - answer only for
`auth.uid()` - would break `fn_club_set_member_role`, which calls it about the
person whose role is changing rather than about the actor, and a half-tightening
that silently returns 0 there would re-create the exact bug this phase came to
fix. The right shape is "the caller, or staff of that club, or their own
upline", and that is a decision with its own blast radius rather than a line in
a conflict resolution.

## Three things I got wrong on the way, since they cost time

**The role change is patched, not re-emitted.** The first version of this
migration carried all 18,519 characters of `fn_club_set_member_role` so the
whole function would be readable in one place. It is a patch now: ten changed
lines are reviewable and 400 unchanged ones are not, and re-emitting silently
clobbers whatever another agent lands in that function between this file being
written and being applied. Every replacement asserts it matched exactly once,
and the patch refuses a definition it does not recognise.

**The reversal script looped forever.** It counted rows with `wc -l` on psql
output, which returns one line even when nothing matched, so `n` never reached 0. It had already reversed all 548,987 rows by then and every extra pass was an
UPDATE that changed nothing, but it would have run until somebody looked. Killed
and finished by hand.

**Main was red when this started**, on `tests/unit/noFixedSizeSourceWindows` -
magic-number source windows from #2474, #2479 and #2464. Fix-first (CLAUDE.md
section 4): bounded by structure instead, in this branch, because you cannot
ship past a red suite anyway.

## The Audit Pass After It, And What It Found

Dan, after the phase shipped: _"MAKE SURE EVERYTHING FROM THE PREVIOUS PHASE WAS
100% COMPLETED ... CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS
OR WIRING ISSUES ANYWHERE AND EVERYWHERE."_ Nine things, all fixed here.

**Money that was never measured.** `ClubFinancialDashboard` drew a pie labelled
"Commission Split" from a hardcoded constant: Club 50, Agents 30, Players 20.
Three numbers nobody had ever measured, on a club owner's financials page, next
to real ones. It reads the three ledgers now - `rake_records`,
`fn_club_commission_accrued`, and rakeback in `chip_transactions`.

**A line that was always zero.** The agent's "Commission Trends" chart fed
`rake: 0` for every day and `FinancialChart` drew the rake series regardless, so
an agent saw a flat green Rake line at zero beside their real commission. The
series is a prop now, and that chart turns it off.

**A number that could not be divided honestly.** The new split cannot use
`club + agents + players` as its whole: commission books to the PLAYER's club
(union law, `credit_agent_commission_from_rake`) while `rake_records` books to
the TABLE's club. Measured while fixing it: SHARK CLUB's last rake row is
2026-08-20, and its agents accrued **309,991.51** in the following week, all of
it at another club's tables. Dividing by the sum would draw "Agents 100%". It
divides by the club's own recorded rake, and shows zero when there is none -
which is what that ledger knows, and what the Daily Rake chart beside it already
showed.

**A list that could not tell claimed from owed.** `AgentDashboardPage`'s
Commission History showed every row identically. Before phase 6 that was fair -
there was no way to claim. It carries a Claimed / Unclaimed column now, and the
CSV export carries `settled_at` with it.

**A migration applied but not committed.** `20260901134946
phase7_definer_grants_are_written_down` went to production through the migration
API and never reached the repo - exactly the state
`check-applied-migrations-are-recorded` exists to catch. The file is here now.

**Two more guard lists naming a dropped function.** Phase 7 took
`atomic_pay_agent_settlement` off `fn_union_money_path_check` and
`guard_wallet_balance_write`; the sweep found it still listed in
`fn_club_arena_global_wallet_check` and `fn_union_overload_check`. Neither could
raise a false alarm - both SELECT from `pg_proc`, and a dropped function returns
no row - but a list naming things that cannot exist stops being read as a list
of things that must. Migration `20260901190748`, with an assertion that no
function anywhere still carries the name.

**Three stale allowlist entries**, whose own text said to remove them when the
cleanup landed (`"UI cleanup pending"`, `"REMOVE THIS ENTRY when that lands"`).
It landed. Also `increment_agent_rake`, still named in the RLS verification
harness after phase 7 dropped it.

**Two names pointing at the wrong file.** Four World Hub comments cited
club-arena migration `20260902070000`; this file was renamed to
`20260901133348` to match the version it was applied under, and another agent
has since created a `20260902070000` about something else entirely.

**A figure computed and thrown away.** `settle-period`'s close now computes what
the club actually paid its agents in the period - and never wrote it. Every row
in `settlement_periods` reads `total_commissions_paid = 0.00`, before this phase
and after it. It is written now.

### What the sweep checked and found clean

- No function, view or RLS policy in the database references
  `pending_commission`, `commission_records` or `commission_history`. Zero.
- The engine's accrual path is untouched and live: `fn_credit_agent_commissions_batch`
  -> `credit_agent_commission_from_rake` -> `agent_commissions`. Commission rows
  have kept arriving throughout (1,541,906 -> 1,551,419 claimable in two hours).
- Fifteen stub functions still exist in the database (VIP points, achievements,
  KYC, an old seat path). **None is called by shipped code in either repo** -
  they are inert, and none is in this programme.
- `settle-period`'s retired `pay` / `pay_all` actions have no caller: no cron,
  no client, only the Zod enum that still permits the word.
- The weekly credit invoice run is wired into the engine's weekly settler
  (`fn_generate_all_credit_invoices`), so "square up weekly" has a scheduler.
- The one agent still in the "not prepaid, no credit line" shape is Dan's own
  SHARK CLUB row, holding 80,000 of float. Probed rolled back: it sends 100 fine
  and refuses 90,000 with _"Your Agent Wallet Only Holds 79,900.00 Chips"_. The
  phase 2 defect was about an EMPTY wallet; this row is not it.
