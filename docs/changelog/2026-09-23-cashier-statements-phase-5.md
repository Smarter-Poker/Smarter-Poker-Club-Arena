# Cashier Statements (Phase 5): One Statement Across Every Wallet, And An Export That Matches The Screen

Migration: `supabase/migrations/20260923131325_cashier_statements_read_every_wallet_in_one_keyset.sql`
(file version). Recorded history version: **20260923150831**
(`cashier_statements_read_every_wallet_in_one_keyset` in
`supabase_migrations.schema_migrations`).

Installed on production 2026-09-23 through Supabase MCP `apply_migration`, as
a single transaction (the file's own `BEGIN` / `COMMIT`). The production
read-back after install matched the fixture:

- All ten `md5(pg_get_functiondef(oid))` values match the fixture's.
- `prosecdef` is true on the six doors and on `fn_cashier_statement_rows`.
- `search_path=public, pg_temp` is set on every function.
- EXECUTE is granted to `authenticated` and `service_role` on the doors only.
- Both job tables have RLS on, zero policies and no browser grants.

`scripts/verification-harness/cashier-release-contract.sql` now requires
version 20260923150831 and pins the six doors' hashes.

## What Existed

The Cashier had one history: `fn_club_trade_ledger`, an OFFSET page of
operation receipts (`chip_transactions`). It had no date range, no filter,
no reference lookup and no export. Table, tournament, promo, ticket and
bonus-game movements are written only to `chip_ledger`, so the Cashier could
not show them at all.

## What Changed

### The statement model

Receipts (`chip_transactions`, of every type) are the authority for every
Cashier operation, exactly as on the on-screen Trade Record. Movements
(`chip_ledger`, status `posted`) are added only for the categories that no
receipt writer covers.

An entry is one of two things:

- **receipt**: a `chip_transactions` row in the club, of any `transaction_type`.
- **movement**: a `chip_ledger` row in the club with status `posted` and a
  category in the included list below. It is left out if a receipt of the
  same club names it by key:
  - the receipt's `metadata->>'idempotency_key'` equals the movement's
    `idempotency_key`, and the receipt was written between one day before
    the range and one day after it. This check uses the partial unique
    index.
  - the movement is a `refund` to a `player_wallet`, and a
    `seat_credit_restored` receipt in the same club for the same player
    (`to_user_id = to_entity_id`), written within one minute of it, carries
    `metadata->>'restore_key'` equal to the movement's `idempotency_key`.
    All 319 production restore pairs have exactly this shape, with a
    sub-second gap; the minute is the safety margin.
  - Restore mirrors are matched on the player wallet index within one
    minute. The check runs only for refunds to a player wallet, as a probe
    on the `(club_id, to_user_id, created_at)` index. The earlier unbounded
    form was a Parallel Seq Scan on `chip_transactions` that cost about
    430 ms of a 472 ms page read on the largest club. The new shape
    measured 4.186 ms for the page, and 1.15 s warm for the whole-club
    92-day totals.

  Each check carries its `metadata ? '<key>'` predicate. These checks are a
  safety net: the category list is what prevents double counting.

Evidence from read-only production probes (2026-09-23):

| Link                                                                                              | Pairs                                                                    | Decision                                             |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| receipt `metadata.chip_ledger_id` → `chip_ledger.id`                                              | 0 ever resolve                                                           | not a check (still printed as `reference.ledger_id`) |
| `idempotency_key` (ticket entry receipt ↔ `ticket_redeem`)                                        | 83, gap 0s                                                               | check kept                                           |
| `restore_key` (`seat_credit_restored` ↔ `refund`)                                                 | 319, gap 0s                                                              | check added                                          |
| `tournament_ticket_issue` ↔ `ticket_issue`                                                        | 726, gap 0s, `ticket_id` only                                            | category excluded                                    |
| `tournament_buyin`, `table_cashout` (receipt `cashout`), wheel/crossing/mines/crash/plinko prizes | 100% mirrored by same-club, same-amount, same-player receipts within ±2s | categories excluded                                  |
| buyin, addon, rebuy, tournament_prize, bounty, refund, spin_entry, spin_prize, promo, overlay     | no receipt                                                               | categories included                                  |

Included movement categories (no receipt writer): buyin, addon, rebuy,
tournament_prize, bounty, refund, spin_entry, spin_prize, promo, promo_send,
treasury_transfer, transfer, player_funding, agent_funding, overlay,
reversal, correction, adjustment, leaderboard_payout.

Excluded because a receipt family mirrors them, so including them would
double count: tournament_buyin, table_cashout, cashout, mint, rakeback,
commission, ticket_issue, ticket_redeem, ticket_cancel, wheel_prize,
plinko_prize, mines_prize, crash_prize, crossing_prize.

Excluded because they are per-hand or system flows with their own
statements: rake, bbj_contribution, bbj_payout, burn, horse_funding,
settlement, legacy_seed_reconcile. Any category not on the included list is
also left out, so a new category stays off the statement until someone adds
it on purpose.

The statement never computes a running balance across the two sources.
A receipt's `balance_after` is the balance of the side that wrote it (the
agent's float on a send, the treasury on a mint). A player would see their
agent's balance, so **every receipt prints `balance_after` as null**. A
movement prints `post_to_balance` or `post_from_balance` only for the side
that is the viewer's own entity; otherwise it is null.

Amounts and totals are positive 2dp strings,
`to_char(round(x, 2), 'FM999999999999999990.00')`, so a figure above 1e13
prints in full and never as `#`.

Every entry reports its wallet family (player, agent, promo, bank, union,
table, ticket, cashout or other). It also reports a direction relative to the
viewer:

- **in**: the viewer receives.
- **out**: the viewer pays.
- **managed**: the viewer is neither side, or is both sides (chips moved
  between two of the viewer's own wallets).

Its state comes only from columns:

- **clawed_back**: the receipt is clawed back.
- **reversed**: the receipt is reversed.
- **pending**: a `cashout_request_escrow` with a `related_cashout_id` and no
  approved, denied, cancelled or expired-refund receipt for the same cashout
  between the escrow and one day after the range ends. The lookup runs only
  for escrow rows. An escrow with no `related_cashout_id` is posted, never
  pending forever.
- **reversible**: `reversible_until` is still in the future.
- **posted**: anything else.

Every entry also carries an immutable reference: id, source, op_id,
idempotency_key, correlation_id, ledger_id, cashout_id and ticket_id. The
exact-reference filter matches any of these fields.

A horse is never named. A receipt type that contains "horse" prints as
`treasury_funding`, which is the label the wallet modal already uses. A note,
ledger label or reference value that contains the word prints as null.
Filters match only the printed values, so no filter can find a hidden one.
`is_horse` is never read.

### The scope rule

The statement uses the same rule as `fn_club_trade_ledger`, which is what the
on-screen Cashier shows. The export is bound to the same rule. The viewer
needs an active or approved membership:

- **owner, co_owner, admin, super_agent**: the whole club.
- **agent, sub_agent**: the recursive `club_members.agent_id` downline of
  active or approved members, including the viewer.
- **any other role**: only rows where the viewer is a side.
- **no membership, a suspended membership or a null role**: nothing.

`fn_club_cashier_scope` sends super_agent to the downline, and the statement
deliberately does not follow it.

### The RPCs

| Function                                                                                              | Who may call it             | What it does                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fn_cashier_statement_scope(uuid)`                                                                    | authenticated, service_role | `{authorized, reason, role, scope, viewer, fingerprint}`. The fingerprint changes with viewer, club, scope or downline membership.                                                                                                                                                                                              |
| `fn_cashier_statement_page(uuid, timestamptz, timestamptz, jsonb, jsonb, integer)`                    | authenticated, service_role | Returns one keyset page ordered `at DESC, source ASC, id DESC`, O(limit). The cursor is `{at, source, id, fp}`, and a cursor from another request is refused with 55000. `totals` is always null. Ranges over 92 days are refused with 22023, and so is an unknown filter key. Lost authorization returns `{authorized:false}`. |
| `fn_cashier_statement_totals(uuid, timestamptz, timestamptz, jsonb)`                                  | authenticated, service_role | Returns `{authorized, scope, range, filters, totals: {in, out, managed, count}, generated_at}` over the whole filtered range, using the page's predicates. It is O(range) and runs as its own call. It uses the same authorization and validation as the page (`{authorized:false}`, 22023).                                    |
| `fn_cashier_statement_export_start(uuid, timestamptz, timestamptz, jsonb, uuid)`                      | authenticated, service_role | Materializes the same rows as one 15-minute job. A repeated request id returns the same job. Each user holds at most one job. A statement over 20,000 entries is refused with 55000 and leaves nothing behind.                                                                                                                  |
| `fn_cashier_statement_export_page(uuid, integer, integer)`                                            | authenticated, service_role | Re-derives the scope on every page. If the scope has changed since preparation, it refuses the whole file with 42501. A job past its expiry is refused with 55000.                                                                                                                                                              |
| `fn_cashier_statement_export_cancel(uuid)`                                                            | authenticated, service_role | Deletes the caller's own job, and retires expired jobs within a bounded budget.                                                                                                                                                                                                                                                 |
| `fn_cashier_statement_rows(...)`                                                                      | owner only                  | The one query behind the page (bounded per source), the totals door (totals mode) and the export.                                                                                                                                                                                                                               |
| `fn_cashier_statement_downline`, `fn_cashier_statement_filters`, `fn_cashier_statement_prune_expired` | owner only                  | Private helpers.                                                                                                                                                                                                                                                                                                                |

The job tables `ca_cashier_statement_exports` and
`ca_cashier_statement_export_rows` have RLS enabled, no policies and no
browser grants. They have no foreign key to a hot table.

### Export safety

- The file is the screen. The page, the totals door and the export all read
  through `fn_cashier_statement_rows`, so a CSV cannot hold a row the viewer
  could not see on screen, or leave one out.
- Every export page asks `fn_cashier_statement_scope` again. A role change or
  downline change after preparation refuses every page of the file,
  including page one. A client therefore cannot join pages that were
  prepared under two different scopes.
- The page door is read-only (STABLE). When the scope has changed it raises
  42501 and deletes nothing; a delete would be rolled back by the raise
  anyway. The refused job is retired by the owner's next start or cancel,
  or by the bounded expiry prune in anyone's next start or cancel.
- Page offsets are clamped to 0..total_rows and computed in bigint, so no
  offset can overflow or step past the file.
- Expiry is enforced at the doors, with no cron. The prune removes at most
  500 jobs per call, and no more rows than one full export beyond the first
  job. It uses `SKIP LOCKED` and a try-lock, so it never waits.

### Bounded reads and the time budget

The first version was measured on production before install. On the
largest club (323k receipts in 30 days), scope all, a 92-day range and the
first page took **3,499 ms** and read 453k buffers. The UNION ALL, the
joins and the top-N sort read every receipt and ledger row in the range, so
the LIMIT never reached the scans. The shape is now:

- **The page is O(limit).** `fn_cashier_statement_rows` reads each source
  on its own. Each source orders by `created_at DESC, id DESC` and applies
  `LIMIT p_limit` inside its own subquery. Every predicate sits inside that
  subquery too: the cursor bound, the category list, the anti-joins and the
  filters. So each index scan stops at the limit.
  - Scope all reads `(club_id, created_at DESC)` on both ledgers.
  - Self and downline read the from-side and the to-side as separate
    branches. Each branch uses its `(club_id, user or entity, created_at)`
    index, and the to-side branch skips rows the from-side branch holds.
  - Only the small candidate sets are merged. They are then joined to
    profiles for labels and cut to the limit.
  - A counterparty text search needs labels to filter, so it joins profiles
    inside the branches, by primary key.
  - A cursor page bounds each branch by the cursor instant.
- **Totals are O(range), in their own door.**
  `fn_cashier_statement_totals` runs a plain SUM/COUNT by direction over the
  same predicates. It has no ORDER BY and no LIMIT, and it joins profiles
  only for a counterparty text search. The page returns `totals: null`. The
  client shows Totals Unavailable when the totals call times out (57014),
  and it keeps the rows.
- **Export start** reads through the same bounded path with a limit of
  20,001. The 20,001-row refusal therefore never sorts the whole range.

No statement function sets `statement_timeout`. A function-level setting
never takes effect, because the timer starts with the outer statement (see
`20260829212453_v30_revert_useless_fn_timeout.sql`). The real budget is the
calling role's timeout (authenticated: 8s) for each call. The post-apply
check refuses a function-level timeout on any of these functions.

Two standalone `EXPLAIN (ANALYZE, BUFFERS)` statements are ready for
production. One is the page read and one is the totals read. Both are
generated from the SQL the function builds, with literal parameters.

## Verification

- `bash scripts/dev/test-cashier-statements.sh` (PostgreSQL 17.11). The
  migration is applied twice, to prove it is idempotent. **206 PASS, 0 FAIL**
  (197 regression assertions and 9 plan checks). The regression covers:
  - **Scope:** every role, the suspended, null-role and non-member cases,
    and the approved status. Row sets equal an independent oracle.
  - **Validation:** the 92-day cap, from < to, and unknown filter keys.
  - **Paging:** keyset paging over at least three pages, with page boundaries
    inside ties on `at` and across a movement-to-receipt tie. There is no
    overlap and no skip.
  - **Cursors:** fp refusal for another filter, another range and another
    viewer.
  - **Filters and references:** every filter, and every reference field.
  - **Model:** the new category set. The mirrored `table_cashout`,
    `ticket_issue` (linked only by ticket_id), `mint`, `cashout`,
    `tournament_buyin` and `rakeback` movements never appear. The
    idempotency_key and restore_key checks hold, including across a range
    boundary. An unreceipted refund appears.
  - **balance_after:** no receipt prints one, even when its source row
    holds one. A movement prints only the viewer's own side, and it equals
    that side's post balance.
  - **Totals door:** authorization (non-member, suspended, no session) and
    22023 validation. For the owner, a player (self), an agent (downline)
    and a cyclic downline, it equals the sum of every page for every filter,
    including label search and an empty match. The page always carries
    `totals: null`.
  - **Escrow state:** an escrow with no cashout id is posted. The terminal
    lookup reaches exactly `p_to + 1 day`.
  - **Amounts:** 9,999,999,999,999.99 rows and a 19,999,999,999,999.98
    total print in full, on the page and in the export.
  - **Horse markers:** none reach any output or filter.
  - **Export:** start, page (equal to the screen), idempotent request id, one
    job per user, expiry, clamped and overflow-safe offsets, a read-only
    refusal on a role or downline change, and the 20,000 cap (20,001
    refused, 20,000 accepted).
  - **Privileges:** ACLs, RLS with zero policies, no function-level
    statement_timeout, and a refused browser call to the private row query.
  - **Plans (auto_explain, the planner left alone after ANALYZE):** each
    source branch is a Limit over its index scan, and chip_transactions is
    never read by a Seq Scan. This holds for scope all (first page and
    cursor page), self (from-side and to-side indexes) and downline. A cursor
    page bounds both ledgers' index scans by the cursor instant. The escrow
    lookup is an index range ending at `p_to + 1 day`. The idempotency
    check uses the partial unique index.
- Twelve deliberate mutations each turn the fixture red:
  - receipt balance_after
  - the restore_key check
  - the old amount format
  - the per-source LIMIT removed (every correctness assertion still passes;
    the plan shape check catches it)
  - the unbounded escrow lookup
  - a null-cashout escrow shown as pending
  - the missing partial-index predicate
  - the missing cursor bound
  - a mirrored category included
  - integer offsets
  - a wrong totals count
  - duplicate downline rows
- `scripts/verification-harness/cashier-statements-probe.sql` is a
  production probe inside one rolled-back transaction. It uses a synthetic
  club and 0.01 receipts only, and never writes to `chip_ledger`. It checks
  25 things: scope, paging, the totals door (owner figures, equality with
  the agent's pages, refusal of a stranger), no totals on the page, no
  receipt balance_after, cursor refusal, export start, page, cancel and
  void, and ACL/RLS. It passes 25/25 against a production-shaped scratch
  cluster. **On production it passed 25/25 in one rolled-back call,
  2026-09-23 around 15:14 UTC.** Before that run, the probe was adapted to
  production's club_members guards:
  - it sets `app.club_membership_source` to `join_club`
    (`fn_require_explicit_club_membership_source`);
  - it skips automated profiles (`fn_ca_reject_automated_user_club_row`);
  - it uses the `player` role (`club_members_role_check`).
- `md5(pg_get_functiondef(oid))` for every function in a scratch PG17
  cluster is identical to the md5 of the catalogue-form source block.
