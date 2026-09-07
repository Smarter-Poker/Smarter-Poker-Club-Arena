# Phase 7: the player, and the second writer

2026-09-07, 22:00-22:35 UTC. Phase 7 of 9 of the chip-accounting programme
(`docs/CHIP-ACCOUNTING-ROADMAP.md`), opened on Dan's "proceed to phase 7 of 9"
after the phase 6 deep dive (#3542) landed. Two roadmap items, 9.5 and 9.6.
Everything below was read from production, from the Club Arena and World Hub
`origin/main`, from GitHub code search across the organisation, and from
Vercel's runtime logs; nothing was assumed.

Two migrations, both applied and proved in-transaction, both byte-identical to
`schema_migrations.statements`:

- `20260907221609_the_second_writer_is_audited_against_the_register` (9.6)
- `20260907222626_a_player_can_audit_their_own_chips` (9.5)

(Each file's first line still carries the version the reservation script
handed out; production stamped the versions above on apply and the files are
named for those.)

Branches: `fix/phase-7-the-player-and-the-second-writer` here, and
`fix/the-second-writer-is-audited` in the World Hub.

---

## 9.6 - the second writer is audited against the register

Phase 5 registered every money door in the database (`ca_money_rpc_registry`,
286 approved, 27 closed). The World Hub carries 69 routes under
`pages/api/club-arena/` that call those doors by name over PostgREST, and
nothing had ever compared the two. "A door is only closed if both repos agree
it is closed."

### What the first comparison found

81 `.rpc()` calls, 77 with a readable payload, every one checked against
`pg_proc` and the register:

| where                       | finding                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promo-wallet.js:140`       | calls `mint_club_promo`, **closed** 2026-09-04, revoked from service_role: "permission denied" as a 500 on every call since                                                                                                                                                                                                                                                                 |
| `union-wallet.js:462`       | calls `fn_union_bbj_pool_payout`, **closed** 2026-09-04: inserts an idempotency claim row, gets permission denied, deletes the claim, answers 500                                                                                                                                                                                                                                           |
| `agent-credit.js:125`       | `fn_atomic_increment_field` with `(p_table, p_field, p_increment, p_where_club_id, p_where_user_id)`; live signature `(p_table_name, p_id, p_field, p_amount)`, whose allowlist has no `club_members` at all. PGRST202 on every call, so the "fallback" - JS arithmetic on `credit_limit` with an optimistic lock, mirrored by hand into `agents` - was the **only path that had ever run** |
| `agent-credit.js:218`       | `fn_add_prepaid_credit_atomic` with `(p_club_id, p_agent_id, p_amount)`; live `(p_club_id, p_user_id, p_amount, p_reason)`. Never worked                                                                                                                                                                                                                                                    |
| `player-retention.js:178`   | `fn_credit_chips` with an extra `source` key. Never worked                                                                                                                                                                                                                                                                                                                                  |
| `record-rake.js:137`        | `increment_settlement_counters` with `(p_club_id, p_rake, p_hands)`; live `(p_club_id, p_period)`. Never worked                                                                                                                                                                                                                                                                             |
| `increment_column`          | a GENERIC door: `UPDATE public.%I SET %I = %I + 1` on any table and column, `EXCEPTION WHEN OTHERS THEN NULL`, service_role only, dynamic SQL so the register's drift scan could not see it. One caller: `table-templates.js`, incrementing `table_templates.use_count`                                                                                                                     |
| `fn_atomic_increment_field` | an allowlisted generic door that reaches `agents.credit_used` and `agents.credit_limit`; executable by `authenticated`; unregistered for the same reason                                                                                                                                                                                                                                    |
| 14 direct writes            | routes writing a balance column through PostgREST with no door: six in `agent-credit.js`, five in `manage-agent.js` (`credit_limit`), and three zero-at-creation inserts (`create-club`, `join-club`, `manage-union`)                                                                                                                                                                       |

And the finding underneath the findings: **eighteen of the World Hub's money
routes have no caller.** Not in Club Arena, not in the World Hub's own pages
(the only mentions are its rate-limiter table and two e2e scripts), not
anywhere in the organisation (GitHub code search), and not in seven days of
Vercel production logs (`agent-credit`, `promo-wallet`, `transfer-chips`,
`leave-club`, `manage-agent`, `rakeback`, `settle-period`, `table-chips`,
`record-rake`, `clawback-chips`, `request-cashout`, `cancel-my-cashout`,
`distribute-promo`, `player-retention`, `table-templates`, `join-club`,
`delete-club`, `create-club`; `approve-cashout` is called by the horses pages,
`union-wallet` by Club Arena's `UnionApiService`). Every defect above except
`union-wallet` and the provisioning inserts sits on a route nobody calls.

### What was built

**The check, permanent.** `fn_ca_second_writer_check(p_calls jsonb)` takes
`[{file, line, fn, keys}]` and answers, per call, from `pg_proc` and the
register: `missing_function`, `closed_door`, `not_executable_by_service_role`,
`signature_mismatch` (PostgREST resolves overloads by NAMED parameters, so a
wrong name is a 404, not a wrong value - the check applies the same rule:
keys must be a subset of one overload's parameters and every non-defaulted
parameter must be sent), and `unregistered_writer` (warning). It counts what
it could not check: a call whose payload is not an object literal is
`unchecked`, by file and line, never fine. Proved in the migration against
six calls whose truth was known.

`scripts/ci/audit-second-writer.mjs` scans the route directory (refusing an
empty one as "a checkout that did not happen", never a clean sweep), sends the
calls, and also reports `direct_balance_write` from the source alone. It runs
as a new job in `schema-manifest-refresh.yml` on the schedules that workflow
already has (hourly, daily; no new trigger), checking the World Hub out beside
this repository with the estate's App token (`repositories:
Smarter-Poker-World-Hub`), and raises and closes a named issue - "Second
writer: a World Hub route disagrees with the money-door register" - so the
finding reaches a person (10.86 rule 3).

Against the World Hub's `origin/main` at 22:16 UTC: 6 errors, 14 direct
writes, exit 1. Against the World Hub branch below: 64 routes, 66 calls, 62
checked, 4 unchecked (`house-ads.js`, variable payloads), 0 errors, 0 direct
writes, exit 0.

**The generic doors, declared.** `increment_column` now carries an allowlist
(`table_templates.use_count`, its one caller), refuses everything else with
P0403, and no longer swallows errors; `fn_atomic_increment_field` is registered
with its allowlist as the note. Both are in `ca_money_rpc_registry`, so the
register is complete about what a caller can reach through them.

**The World Hub, in its own pull request** (`fix/the-second-writer-is-audited`):

- `union-wallet.js` `process_bbj_payout` refuses (410) before it writes
  anything, naming the retired door; the jackpot is paid by the engine.
- `agent-credit.js`, `player-retention.js`, `record-rake.js`, `promo-wallet.js`
  and `manage-agent.js` are **removed**: every one uncalled by any application
  code in the organisation, invisible in seven days of production logs, and
  every one carrying a call that has never matched a live signature, a closed
  door, or JS arithmetic on a balance column. Their rate-limiter rows and the
  freeze-check baseline entries go with them (that baseline is shrink-only).
  Club Arena adjusts agent credit through `fn_admin_update_agent`, a registered
  door, from the browser; the engine records rake itself.
- `create-club.js`, `join-club.js`, `manage-union.js` stop naming balance
  columns in their provisioning inserts. The columns are `NOT NULL DEFAULT 0`
  and `trg_membership_starts_with_zero_chips` enforces the zero anyway; a
  route never names a balance column, not even to write a zero.

### For a decision - not done here

Thirteen more money routes with no caller anywhere (`transfer-chips`,
`leave-club`, `rakeback`, `settle-period`, `table-chips`, `clawback-chips`,
`request-cashout`, `cancel-my-cashout`, `distribute-promo`, `table-templates`,
`join-club`, `delete-club`, `create-club`) agree with the register and were
left in place. They are doors both repos agree are open, that nobody walks
through. Each is a route an attacker could still POST to with a valid JWT and
that no screen exercises; the check above keeps them honest, but the question
of whether they should exist is Dan's. Also open: the four unregistered writers
`fn_ca_money_rpc_drift` is currently reporting (`fn_bbj_mini_payout`,
`fn_remove_settled_club_member`, `fn_retire_settled_club`,
`atomic_tournament_register`) belong to other lanes' work today and carry
their own warning incidents.

---

## 9.5 - a player can audit their own chips

### What was there

A surface did exist: `TransactionLedgerView` on the wallet page's Ledger tab,
reading `chip_ledger` with `performed_by.eq.<me>,to_entity_id.eq.<me>`. It
never asked for `from_entity_id`, so every chip that LEFT the player - buy-ins,
tournament entries, add-ons, rebuys - was invisible; only credits showed.
"Where did my chips go" was the one question it could not answer. And it was a
feed, not a statement: twenty rows, no balance, nothing to check a balance
against.

Meanwhile the comparison the standard already makes had no reader outside the
team: `fn_ca_ledger_replay` reads every wallet against the journal nightly and
writes the reading to `ca_account_snapshots` (balance, taken_at,
cum_unexplained).

### What was built

`fn_ca_chip_statement(scope, club, before, limit)`:

- **scope `player`** is always the caller's own wallet. The entity is
  `auth.uid()` and is not a parameter; a horse and a human get the identical
  answer (10.5 - the migration asserts from the catalogue that the function
  never mentions `is_horse`).
- **scope `club_treasury`** is gated on `ca_can_view_club_finances`, the same
  gate the club ledger already uses.
- The answer carries the balance now (per club and in total), a page of legs
  from the account's point of view (`in`/`out`, counterparty type and label,
  hand/tournament/table ids), one index range per side over the entity indexes
  that already exist, and the **audit block**: the last nightly reading, the
  journal's in and out since it, `expected_now = balance_at_reading + in -
out`, the balance now, and the difference - with a stated status:
  `reconciles`, `does_not_reconcile`, `no_reading_yet`, `no_balance`. The
  three numbers are the same three the platform's own control uses.

Measured on the busiest wallet of the evening (a horse): 50 legs, both
directions, `reconciles` - 255,662.53 at the 06:40 reading, plus 2,329.95 in,
minus 1,123.00 out over 89 movements, equals 256,869.48, which is the balance;
525 ms under evening load.

`src/components/wallet/ChipStatement.tsx` renders it - mobile first, both
directions, the audit line in the player's words, balance by club, paging by
`next_before`, and an error that is never read as "no movements" - and
replaces the one-sided feed on the wallet page's Ledger tab. The club
financials page gets the treasury statement beside its ledger. The feed
component that remains (agent portal, union dashboard) now asks for
`from_entity_id` too.

Six component tests (`tests/unit/ChipStatement.test.tsx`), two law tests
(`tests/a-player-can-audit-their-own-chips.law.test.ts`,
`tests/the-second-writer-is-audited.law.test.ts`, 13 assertions), both
registered in `docs/laws.d/`.

---

## Still open, carried

Unchanged from phase 6: 364.80 owed to three tournament winners pending Dan's
bubble-protection decision; the one unbanked raked hand (`56d12749`, 7.50);
idempotency keys on 0.08% of legs; partition cut stages 2-5; the restatement
policy as a written policy (9.3, phase 9).
