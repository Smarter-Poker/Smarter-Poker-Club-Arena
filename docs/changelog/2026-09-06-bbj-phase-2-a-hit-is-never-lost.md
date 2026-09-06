# 2026-09-06 - BBJ build plan, Phase 2 of 6: a hit is never lost

Plan of record: `docs/BBJ-BUILD-PLAN.md`. Runbook: `docs/BBJ-RUNBOOK.md`.
Follows phase 1 (`2026-09-05-bbj-phase-1-record-and-moment.md`) and the audit
before it (`2026-09-05-bbj-full-audit.md`).

Phase 1 made a failed payout retry, and after four attempts queue itself for
the reconciler. This phase closes what was still open around that: the window
before the first attempt, the silence at the table while the money is late,
and the one recipient who could still cost everybody else their jackpot.

## 2.1 The intent is durable before the money is attempted

The queue row was written only AFTER four attempts had failed. That leaves the
window the queue exists to close: the engine detects a jackpot, announces it
to the table with `bbj_hit`, and the process dies - a SIGKILL, an OOM, the box
going away - before any row exists. Nothing afterwards knows a jackpot was
owed. The pool keeps the money and the only trace is a log line in a process
that is gone.

`processBBJPayout` now CLAIMS before it tries. The claim goes in
`pending_fee_distributions` (kind `bbj_payout`) with the full parameter set,
while the money is still in the pool, and the outcome closes it:

| outcome                                                | what happens to the claim                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| paid                                                   | settled, with what was paid to how many                                                                                                     |
| already paid (a replay)                                | settled; the RPC re-drove any missing credit                                                                                                |
| nothing to pay (no pool, empty pool, refused argument) | settled with the reason - an open claim for a hand that can NEVER pay would be re-driven 25 times and end in a critical alert about nothing |
| every attempt failed                                   | left open, note refreshed with the error, CRITICAL alert                                                                                    |

The return type carries that distinction now (`BBJPayoutOutcome`). It used to
be `BBJPayoutResult | null`, and `null` meant four different things - paid,
already paid, nothing to pay, could not pay - so the reconciler had to ask the
ledger which one it was, and the table had no way to say "paying shortly".

Bookkeeping can never stop the money: every claim and settle goes through a
wrapper that swallows and reports. If the database is unreachable the payout
is attempted anyway (it may be Realtime that is unwell, not Postgres).

## 2.2 The table is told, whether the money is now or later

A jackpot that cannot land this instant produced SILENCE. `bbj_hit` had gone
out, the celebration waits on `bbj_payout_complete`, and that never arrived.
The players who had just taken and beaten a qualifying hand saw the hand end
normally and nothing else, and the chips appeared minutes later with no
explanation. The ordinary cause is not exotic: the `:55` maintenance freeze
refuses every money write for five minutes of every hour.

- The engine emits **`bbj_payout_pending`** when the payout is queued, and the
  table says so.
- The reconciler emits **`bbj_payout_paid`** when the drain lands it, carrying
  the total when it knows it.
- Both are retained for 60 s like every other jackpot beat, and both go
  through the same freshness/identity gate, so a reconnect still hears them
  and a replay cannot announce twice.

The late one is a notice rather than the ten-second overlay: the hand is
minutes old by then, and every recipient already has a notification saying
exactly what they were paid and where it went (phase 1.1).

The reconciler reaches the hub through a LAZY import. A static one pulls
`TableStateHub -> handFacts -> the real Supabase client` into module-init for
every consumer of `FeeReconciler`, which broke an unrelated test with a
temporal-dead-zone error before it could break anything in production.

## 2.3 One unpayable share no longer costs everyone else theirs

`bbj_credit_one_recipient` RAISED when no club wallet resolved for a departed
recipient. Every credit runs inside `bbj_atomic_payout_v2`'s single
transaction, so that raise rolled back the WHOLE jackpot: the bad-beat holder,
the hand winner and the entire table were paid nothing because ONE table-share
recipient held no active membership anywhere. The reconciler then re-drove it
into the same wall every five minutes until it exhausted.

The audit fixed the common CAUSE (a union table resolved to the union's shell
club, where the player was not a member). This fixes the CONSEQUENCE.

Migration `20260906152329_an_unpayable_jackpot_share_is_parked_not_lost`:

1. the claim is released (`bbj_payout_recipients` row and the
   `wallet_credit_idempotency` key), so a later re-drive CAN pay them once
   they hold a club membership again;
2. the chips go back to the pool they left moments earlier in the same
   transaction - which is what keeps conservation EXACT, because the pool was
   debited for the full award before the credits ran;
3. `bbj_unclaimed_shares` records who is owed what and why, and
   `fn_bbj_unclaimed_shares()` lists every open one;
4. a WARNING financial alert names the players and amounts, because a debt
   nobody is told about is the failure this phase is against.

**Probed on production first, in a self-aborting transaction** (CLAUDE.md 11.5
as amended - one MCP call, one `DO` block, an error IS the success case), with
one recipient deliberately made unpayable:

```
award 26,524.30 | pool debited 24,313.94 | delivered 24,313.94
parked 2,210.36 | debit == delivered: true | 4 recipients | 1 unclaimed row
```

24,313.94 + 2,210.36 = 26,524.30. Before this change that hand paid nobody at
all. The rollback left nothing: no table, no function change, no membership
edits, pool `hit_count` still 45.

**What this does NOT decide.** It does not write the debt off and it does not
pay it to anyone else. The player remains owed. Deciding what becomes of a
share nobody ever claims is a policy question about money and it is Dan's
(CLAUDE.md 10.9), not one to settle quietly inside a payout function.

## 2.4 The whole path is counted

`poker_bbj_hits_detected_total`, `poker_bbj_payouts_paid_total`,
`poker_bbj_payouts_queued_total`, `poker_bbj_shares_parked_total`.

The useful reading is the DIFFERENCE. `detected == paid` is health; a detected
that becomes neither paid nor queued is the failure this phase makes
impossible, and it is now two counters that stopped agreeing rather than
something somebody notices in a ledger weeks later.

## 2.5 Tests

`server/src/engine/AJackpotIsNeverLost.test.ts` (14) pins the seam between the
settlement step and its collaborators - claim before the loop, every terminal
outcome settling, both announcements retained and gated, the parked-share
alert, and the counters being incremented on DIFFERENT outcomes so a gap is
visible. `BBJPayoutIsPaidOrQueued` grew to 19 and now asserts the write-ahead
behaviour directly, including that a paid jackpot and a replay both CLOSE
their claim.

The first draft of the new test bounded three source windows with byte counts
and `tests/unit/noFixedSizeSourceWindows.test.ts` refused it - correctly, and
for a reason worth repeating: a 7,000-character window once drifted off the
end of what it guarded and stopped the whole estate publishing for 39 minutes.
Rewritten against `tests/helpers/sourceWindow`.

## Verified

Client `tsc` clean, server `tsc` clean, server 434 files / 6,221 tests, client
1,093 files across six shards, all green. Migration probed rolled back, then
applied.

## The deep dive before phase 3, and the four defects it found in this phase

Dan's standing rule between phases: prove the last one is fully built, coded,
wired in and tested before starting the next. Four things failed that, three of
them in code that had already passed tsc, 6,239 server tests and every required
check. Each is written here as what it was, not as what it became.

### 1. Phase 2.2 was emitted, handled, and swallowed one layer in

`shouldAnnounceBbjHit` identifies a jackpot by **table + hand and nothing
else**, and marks it seen the first time it says yes. So on the path this phase
was built for - a payout that cannot land now - `bbj_payout_pending` marked the
hit seen, and `bbj_payout_paid` for the same hand was then refused **as a
replay of itself**. The player was told the money was coming and never told it
had arrived.

Everything else about it worked: the engine emitted, the hub retained, the
client handled, and the source pin asserting "the handler calls the gate"
passed - which is exactly why the pin did not catch it. The gate now takes a
`kind`, so the three things one jackpot can say each de-duplicate on their own
and each is still said at most once. The default is the empty string, so the
celebration and the club-wide card keep the key they have always had and keep
sharing it: those two are one announcement seen from two places, and the card
already refuses the table you are looking at.

### 2. The hub could no longer hold one jackpot's beats

Every retained emit on a cash table is a jackpot beat, and this phase took that
from three to five - `bbj_hit`, `bbj_payout_pending`, `bbj_payout_complete`,
`bbj_hit_global`, `bbj_payout_paid` - against a per-table cap of **four**. The
splice drops the OLDEST, which is `bbj_hit`: the beat carrying the hand names
the celebration is built from, whose own retention comment (added in phase 1)
says it exists so a player reconnecting through the hit still receives them.
Phase 1 wrote a guarantee and phase 2 quietly spent it.

The cap is 8 with the measurement beside it. `TableStateHub.replay.test.ts`
pinned the literal 4 and went red for a correct change; it now READS the cap
and pins the behaviour - bounded, newest wins - because a number tuned to one
shape of traffic and copied into a test outlives the shape it was tuned to.

### 3. A counter declared and written to nowhere

`poker_bbj_shares_parked_total` shipped beside detected, paid and queued, and
was incremented in no code path at all. It would have read a flat zero for
ever, indistinguishable from "no share was ever parked" - the same shape as an
empty alert group reading as coverage. It is now incremented where the park is
detected, and the test asserts every declared counter is written to somewhere
rather than merely declared.

### 4. Two migrations the repo could not tie to the database

The Supabase MCP assigns its own version when it applies a migration, and it
recorded `an_unpayable_jackpot_share_is_parked_not_lost` as **20260906152640**
while the file said 20260906152329. A file whose version is not the version the
database recorded is a migration a rebuild applies a second time. Renamed, as
the three earlier files in this series already were.

Worse, the REVOKE that closed `fn_bbj_unclaimed_shares` to the browser was
applied live as `20260906153916` and **had no file at all** - the exact gap
`check-applied-migrations-are-recorded.mjs` exists to report, and one a Midway
master reset would rebuild without. Written down verbatim, with a header saying
it is the live twin of the block folded into 20260906152640.

### And one latent hazard closed while it was cheap

`bbj_unclaimed_shares` - the row that says a named player is owed a named
number of chips - inherited Supabase's default `GRANT ALL` to `anon` and
`authenticated`. Nothing was exploitable: RLS is on and its only policy is
SELECT-only, so a write from a browser role is refused today whatever the grant
says. But that protection rests entirely on nobody ever adding a permissive
`FOR ALL` policy, which is the natural way somebody would let a player read
their own row. Both writers of the table are SECURITY DEFINER, so
`20260906160939_a_parked_jackpot_share_is_not_a_browser_write` revokes the
write grants and keeps SELECT, and nothing loses a path.

### What the deep dive also found that is NOT this phase

`fn_rake_bbj_audit` has raised CRITICAL `I7_raked_hand_never_banked` alerts
repeatedly - 5 violations at 07:38, 3 at 06:38. Read rather than assumed:
**zero** hands are unbanked right now (0 of 51,733 raked hands / 62,498.69
chips in the last 24 hours), and `rake-repair-unbanked-hourly` last ran seven
minutes before the check. So the alert is firing on hands the hourly repair
then fixes - a CRITICAL that fires on correct behaviour, which is how real
alarms get ignored - and, underneath it, a rake that is not banked inline and
is caught by a repair job every hour, which by CLAUDE.md 10.11 means the cause
is not fixed. Both belong to phase 5 (close the books) and are recorded there
rather than half-fixed here.
