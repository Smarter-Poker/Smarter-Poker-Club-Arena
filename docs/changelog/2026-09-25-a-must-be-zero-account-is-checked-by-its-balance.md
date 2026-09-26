# A must_be_zero account is checked by its balance, not by an hour of flow

**2026-09-25** — branch `fix/a-must-be-zero-account-is-checked-by-its-balance`

`ca_ledger_accounts` has said since `20260831143501` that `settlement_suspense`
is `must_be_zero`: _"must net to zero; never a place to hide drift."_

Measured on production at 12:52 UTC today, it stands at **+4,170,904.48**.

Nothing noticed, and there were two separate reasons, either of which alone
would have been enough.

**The column is read by nobody.** `must_be_zero` appears in the migration that
created the table and in the schema manifest that records the table's shape. No
function, view, trigger, constraint, check or test in the database reads it. It
was a comment with a data type.

**Its only detector measures the wrong thing.** `fn_ca_suspense_regression_check`
(cron job 177, `*/15`) sums `created_at > now() - interval '60 minutes'` and
alerts when `abs(net) > 1.00`. That is an hour of _flow_. The last leg touching
suspense was written **2026-09-14 06:27:40 UTC**, so for eleven days the
detector has correctly and truthfully reported zero, every fifteen minutes,
while four million chips sat in an account declared to hold none. A static
imbalance is precisely the case a flow window cannot see, and it is the case the
declaration is written about.

## The measurement

|                              |  legs |            chips |
| ---------------------------- | ----: | ---------------: |
| into `settlement_suspense`   | 7,743 |    21,730,142.57 |
| out of `settlement_suspense` | 4,676 |    17,559,238.09 |
| **balance**                  |       | **4,170,904.48** |

By category: `adjustment` +4,041,027.18, `spin_prize` +214,673.00,
`rakeback` −84,345.70, `correction` −450.00. First leg 2026-08-31 14:40:51,
last leg 2026-09-14 06:27:40.

## What the four million is: mostly an observation artifact, and not stranded chips

This mattered more than the number. The remedy for stranded chips and the
remedy for a double-counted observation are opposite remedies, and the wrong one
destroys real money.

Almost every leg reads `auto-ledgered <table>.<column> delta …` or
`auto-audited …`. That is `fn_ca_autoledger`: a **balance watcher**, not a money
mover. When a watched balance column changes, it writes a journal leg whose
_other_ side is `current_setting('app.ledger_counterparty')` — and its default,
when the writer declared nothing, is `settlement_suspense`. So suspense is not a
place chips are held. It is the name the journal gives to _an unobserved
counterparty_.

Pairing every suspense leg by exact instant and amount:

- **17,310,078.63** across **5,750** legs pairs off exactly — one real movement
  seen twice by the same watcher, once from each side, netting to zero across
  suspense. That is the design working.
- the whole **4,170,904.48** is the unpaired residue, and it is dominated by
  two groups.

**`adjustment` — double observation. Artifact.** The largest single unpaired
group is **416 legs of exactly 10,000.00 (4,160,000.00)**, all inside 21 minutes
on 2026-09-01, `agent_wallet → settlement_suspense`. For **416 of 416** there is
a leg at the _same microsecond, same amount_:
`adjustment table_stack → player_wallet 10000.00 "auto-audited
club_members.chip_balance delta 10000.00"`. One agent-to-member distribution,
observed twice by two different watchers — `fn_ca_autoledger` on
`agents.agent_wallet_balance`, which names `settlement_suspense`, and the
`club_members` writer, which names `table_stack` — neither pointing at the
other. The chips are in the member's wallet. Nothing is stranded. The
`correction` legs already in the journal say this in their own words: _"Cancels
the anonymous twin of round 2 agent wallet credit for this pair."_

**`spin_prize` — a single observation with the wrong counterparty. Real, and
already closed.** 3,792 legs, 214,673.00, `spin_reserve → settlement_suspense`,
2026-09-01 19:14 to 2026-09-02 22:05. **0 of 3,792** have a same-instant
correctly-typed twin: these are not double-observed. They are the spin prize
draw debiting `spin_bonus_pools.balance` while the producer had declared its
category but not its counterparty, so the leg named the default. The correctly
typed path `spin_reserve → prize_liability` carries **91,403 legs / 5,859,584.00
and is still running today (last leg 2026-09-24 06:25)**; the mis-typed shape
stops dead on 2026-09-02. `fn_spin_settle_game` as installed today sets
`app.ledger_counterparty = 'prize_liability'`, and `20260908024909` made a
journal failure roll back the movement instead of falling through to an
`adjustment` against suspense. **The producer is already fixed forward. There is
nothing to fix at the writer, and the 3,792 historical legs are not re-typed —
that would be rewriting financial history.** The one prize that actually went
unpaid because of this was settled on 2026-09-07 by `20260907224500`.

Since 2026-09-08 the daily net through suspense is 4.55, then 0.00, then 0.00.
The imbalance is a closed historical window, not a live leak — but it is a
number no control could see, and that is what this change fixes.

## The fix

`fn_ca_suspense_regression_check` keeps its flow arm **byte-for-byte**: same
floor, same 1.00 tolerance, same `suspense-regression` key, same wording. It
gains the check the declaration actually asks for.

- It iterates `ca_ledger_accounts WHERE must_be_zero`. The column now has
  exactly one reader, and flipping another account is enough to have it checked
  on the next run — proven in the probe.
- **Balance arm**: `abs(balance) > 1.00` files
  `must-be-zero-balance:<account>`, `ledger_imbalance`, critical, carrying the
  balance, the legs and the chips both ways, through the existing
  `fn_ca_raise_drift_incident` → `ca_drift_incidents` / `financial_alerts`
  surface. It folds to **one standing incident**, not ninety-six a day.
- **Growth arm**: the balance at install is recorded as
  `ca_must_be_zero_state.baseline_balance`. Movement away from it files a
  separate `must-be-zero-growth:<account>`. The standing four million is already
  the owner's decision; a balance that _keeps moving_ is a live writer, and that
  is the louder finding.
- A condition that stops being true closes itself. A balance back within
  tolerance of zero resolves both keys with `closure_basis =
'condition_no_longer_holds'`.

**No new cron, watcher, reconciler or repair loop.** Job 177 still calls this
one function. No chip is moved anywhere.

### Why it stays cheap on a 5.8M-row journal

`chip_ledger` is 5,820,918 rows / 5,294 MB with no index on `from_type` or
`to_type`, so `sum(...) WHERE to_type = 'settlement_suspense'` is a sequential
scan. Ninety-six of those a day is not a control, it is a second workload. So
the balance is **maintained**, in the shape `ca_ledger_day_manifests` and
`member_fee_rollup_state` already use here:

- `ca_must_be_zero_hours` holds one row per (account, UTC hour) — **58 rows** for
  the entire history of `settlement_suspense`.
- each run re-derives only buckets at or after
  `date_trunc('hour', now()) - interval '2 hours'`, through
  `idx_chip_ledger_created_at`: **8,319 rows** measured, against the **3,942**
  the installed check already scans. The balance itself is a sum over that
  58-row table.
- the two-hour lip is the late-commit margin, and buckets are **recomputed**
  rather than incremented, so a transaction that opened before the window and
  commits inside it is still counted exactly once.
- the seed is the one unbounded read this change ever performs, inside the
  install transaction, once.
- a `pg_try_advisory_xact_lock` keeps one writer on the buckets; an overlapping
  run skips the balance arm and still runs the read-only flow arm.

The probe proves the boundedness behaviourally: it deletes a sealed row behind
the detector's back and the reported balance does not move.

### It declares its own guard change

`fn_ca_suspense_regression_check` is on `fn_ca_guard_watchlist()`, so the
redefinition calls `fn_ca_declare_guard_redefinition` in the same transaction,
naming this migration. The guard baseline moves to the definition this
transaction produced and the previous text is kept in `ca_guard_def_history` to
diff against, so `fn_ca_guard_defs_watch` has nothing for a human to close by
hand.

### It refuses to re-baseline itself

The migration will not apply over anything but the reviewed installed
definition, **including its own candidate**. A second application would re-read
the journal and re-baseline the standing imbalance to whatever it had become,
which would silently authorise it. Replay is refused by name.

## What the owner still has to decide

The 4,170,904.48 is untouched, and deliberately. What it would take to resolve
it, and the decision only the owner can make:

1. **The `adjustment` residue (~4.04M) is an accounting artifact, not chips.**
   No store holds it; it is the net of half-observed movements whose
   counterparty store was never watched. Resolving it means posting
   _correction_ legs that name the real counterparty for each unpaired
   observation — the precedent already exists in the journal
   (`"Cancels the anonymous twin …"`, 2026-09-06 and 2026-09-09) — or declaring
   a one-time audited opening balance for the pre-2026-09-08 era. Either is a
   journal restatement with the owner's name on it, not an agent's adjustment.
2. **The `spin_prize` residue (214,673.00) is 3,792 real prize draws whose leg
   named the wrong counterparty.** The money left the spin reserve and reached
   the prize path; only the journal is wrong. Re-typing 3,792 historical legs is
   rewriting financial history and is not being done.
3. **`fn_ca_autoledger` still defaults its counterparty to
   `settlement_suspense`.** That is the design, and it is why this account
   exists. What was missing was anything that read the balance. As of this
   change, a writer that forgets to declare its counterparty is visible within
   fifteen minutes instead of never.

The question for the owner is (1): restate the pre-2026-09-08 era against a
named opening balance, or leave the standing incident open as the permanent
record of it. Nothing needs to move either way.

## Proof

`scripts/ci/test-must-be-zero-balance-detector.py` — 50 checks, PG17, an owned
cluster, production's real `fn_ca_raise_drift_incident`,
`fn_ca_is_midway_scope` and `fn_ca_stable_dedupe_key` verified by md5 against
the installed definitions. RED is the installed detector against the exact
production figures with no leg for eleven days: it reports **0** and files
nothing. GREEN is the same state through the candidate: balance reported,
incident filed, one incident across nine runs, one notification. Wired into
`accounting_postgres`.

Sept 28 rehearsal: recorded in this change's PR.

## Files

- `supabase/migrations/20260925131500_a_must_be_zero_account_is_checked_by_its_balance.sql`
- `scripts/ci/test-must-be-zero-balance-detector.py`
- `scripts/ci/probes/must-be-zero-balance/{catalog,incident-filer,installed-detector}.sql`
- `.github/workflows/ci.yml`
