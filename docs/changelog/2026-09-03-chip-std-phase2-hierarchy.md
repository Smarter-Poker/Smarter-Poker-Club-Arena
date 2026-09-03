# 2026-09-03 - chip-std Phase 2, lane 2.4: hierarchy sends are ledgered in substance

Audit round 2, lane 2 (`docs/audits/2026-09-02-chip-standard-round2/lane2-hierarchy.md`),
finding F3 (High). Branch `fix/chip-std-p2-hierarchy-declared`. Two migrations,
applied to production 2026-09-03 and mirrored byte-exact:

- `20260903165749_the_hierarchy_has_words_for_its_sends_and_an_undeclared_wallet_write_is_honest.sql`
- `20260903170529_the_hierarchy_sends_are_one_journal_row_each.sql`

Law test: `tests/the-hierarchy-sends-are-one-journal-row-each.law.test.ts` (23 rules).

## The finding

The hierarchy RPCs (club bank send / claim / reverse, agent wallet send /
claim / self-stake, promo send, union clawback, staff pull) write two balance
columns and journal nothing themselves. The auto-ledger triggers
(`fn_ca_autoledger` on clubs / agents / union_wallets,
`fn_club_members_ledger_writer` on club_members.chip_balance) each wrote one
single-leg `adjustment` row per column against `settlement_suspense`, and the
club_members writer invented `table_stack` as the player-side counterparty.
No idempotency key, no correlation.

Verified on production rows before anything was touched (all
`actor_service = PostgREST 14.5`, `db_role = postgres`, key NULL):

| RPC, when                                   | Amount       | Journal as it was                                                                                    |
| ------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| `fn_agent_wallet_send` 09-01 14:23:18       | 10,000.00    | `adjustment agent_wallet -> settlement_suspense` + `adjustment table_stack -> player_wallet`         |
| `fn_agent_wallet_self_stake` 09-01 14:23:19 | 10,000.00    | same two legs                                                                                        |
| `fn_club_bank_send` 09-01 14:02:19          | 3,750,000.00 | `adjustment club_treasury -> settlement_suspense` + `adjustment settlement_suspense -> agent_wallet` |

30-day volume through the doors (`chip_transactions`): `agent_wallet_send`
416 rows / 12,860,000.00; `agent_wallet_self_stake` 32 / 320,000.00;
`club_bank_send` 5 / 7,601,001.00; `club_bank_reversal` 1 / 1.00;
`admin_removal` 1 / 1.00; claim backs, promo sends, clawbacks 0. In the 24h
before this work the hierarchy doors moved nothing at all (last send 09-01
14:23), and since 2026-09-02 23:00 UTC (Phase 1.2 / 1.3 draining the felt
legs) `chip_ledger` has had ZERO settlement_suspense rows per hour. So the
"before" inflow rate from these writers over the last day is 0 rows/hour; the
audit's +182,131.56 / 23h was measured on 09-02 when sends were flowing.

## Step 1 - inventory of the live doors (read from `pg_proc`, 2026-09-03 ~16:30 UTC)

| Route | Function (lines)                                                                                | Balance columns written                                                                                              | Auto-ledger produced (undeclared)                                                            | Declared before? | Callers in repo                                                                 |
| ----- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------- |
| C1    | `fn_club_bank_send` (178)                                                                       | `clubs.chip_treasury` -> `agents.agent_wallet_balance` / `agents.promo_wallet_balance` / `club_members.chip_balance` | `club_treasury -> suspense` + `suspense -> agent_wallet` (or `table_stack -> player_wallet`) | no               | WalletCashierModal, CashierPage, ChipTransferModal                              |
| C2a   | `fn_club_bank_claim_back` (168)                                                                 | wallet -> `clubs.chip_treasury`                                                                                      | same shape, reversed                                                                         | no               | WalletCashierModal                                                              |
| C2b   | `fn_club_bank_reverse` (124)                                                                    | recipient wallet -> `clubs.chip_treasury`                                                                            | same                                                                                         | no               | WalletCashierModal                                                              |
| C2c   | `fn_admin_remove_player_chips` (111)                                                            | `club_members.chip_balance` -> `clubs.chip_treasury`                                                                 | `player_wallet -> table_stack` + `suspense -> club_treasury`                                 | no               | CashoutService                                                                  |
| C3a   | `fn_agent_wallet_send` -> `_phase2_core_20260831` -> `fn_agent_wallet_send_core_20260830` (236) | `agents.agent_wallet_balance` (+ `credit_used`) -> `club_members.chip_balance` or `agents.agent_wallet_balance`      | `agent_wallet -> suspense` + `table_stack -> player_wallet` (verified)                       | no               | CashierPage, CashierTradePage, WalletCashierModal, AgentService, CashoutService |
| C3b   | `fn_agent_wallet_claim_back` -> `fn_agent_wallet_claim_back_phase2_core_20260831` (268)         | holder wallet -> `agents.agent_wallet_balance` (+ `credit_used`)                                                     | same shape, reversed                                                                         | no               | CashoutRequestModal, WalletCashierModal, CashoutService                         |
| C3c   | `fn_agent_wallet_self_stake` (87)                                                               | `agents.agent_wallet_balance` -> `club_members.chip_balance` (same user)                                             | `agent_wallet -> suspense` + `table_stack -> player_wallet` (verified)                       | no               | none in `src/` (32 rows in 30d)                                                 |
| C3d   | `fn_promo_wallet_send` (166)                                                                    | `agents.promo_wallet_balance` -> `club_members.chip_balance` or `agents.promo_wallet_balance`                        | `promo_wallet -> suspense` + ...                                                             | no               | AgentPromoPanel, WalletCashierModal                                             |
| U3c   | `fn_union_clawback_from_club` (64)                                                              | `clubs.chip_treasury` -> `union_wallets.chip_balance`                                                                | `club_treasury -> suspense` + `suspense -> union_bank`                                       | no               | UnionWalletModal, UnionDashboardPage                                            |
| U3a   | `fn_union_send_to_club_atomic` (51)                                                             | `union_wallets.chip_balance` -> `clubs.chip_treasury`                                                                | undeclared                                                                                   | no               | NONE (orphan, F9) - not changed                                                 |
| U3b   | `fn_union_send_chips_to_club` (49)                                                              | union bank -> owner's player wallet                                                                                  | undeclared                                                                                   | no               | NONE (orphan, F9) - not changed                                                 |
| C2d   | `fn_wallet_claim_back` (184)                                                                    | downline player wallet -> agent float                                                                                | undeclared                                                                                   | no               | NONE (orphan, F9, another lane revokes) - not changed                           |
| C2e   | `fn_cashier_claim_back` (143), `fn_cashier_send_chips` (125)                                    | player wallet <-> player wallet                                                                                      | undeclared                                                                                   | no               | CashierTradePage says it stopped calling them; service_role only - not changed  |
| C8    | `fn_member_leave_to_treasury` (58)                                                              | `club_members.chip_balance` -> `clubs.chip_treasury`, then DELETE                                                    | wallet side journaled by `fn_ca_autoledger_delete`                                           | no               | policy question (P12), not a declaration - not changed                          |

Every changed function was already in `ca_money_rpc_registry`; none is above
the ~300-line ceiling (the longest, the claim-back core, is 268).

## Step 2 - the vocabulary

`chip_ledger_category_check` had 48 words. `commission`, `rakeback`,
`promo_send`, `credit_draw`, `credit_repayment` and `reversal` were already
there; the five missing were added: `club_bank_send`, `club_bank_claim`,
`agent_send`, `agent_claim`, `union_settlement`. Dropped and re-added `NOT
VALID` (no scan of the journal), the exact shape of 20260831233537. The
counterparties needed (`club_treasury`, `agent_wallet`, `player_wallet`,
`union_bank`, `promo_wallet`, `credit_facility`) were already in both type
CHECKs.

## Step 3 - the declarations

Each door calls `fn_ca_declare_ledger(category, counterparty, entity, NULL,
'<door>:' || op_id, ARRAY[<other side's table>])` before its first balance
write, sets `app.ledger_correlation = op_id`, and clears the autoskip right
after the write it covered. `fn_club_members_ledger_writer` does not read the
autoskip GUC, so the club_members side always writes and the treasury / float
side is the side skipped. Where both sides are in `agents` (float -> float,
promo -> promo) the table is skipped and the row is posted through a new
service_role-only primitive `fn_ca_post_leg(...)`, which inserts one
`chip_ledger` row with an explicit key and, like every balance trigger and
`fn_horse_fund_from_treasury`, swallows a failed insert into
`ca_ledger_write_failures` rather than refusing the money.

| Door              | Category           | Row                                                                                                                                                         |
| ----------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 club bank send | `club_bank_send`   | `club_treasury(club) -> agent_wallet / promo_wallet / player_wallet(user)`                                                                                  |
| C2a claim back    | `club_bank_claim`  | `agent_wallet / promo_wallet / player_wallet(user) -> club_treasury(club)`                                                                                  |
| C2b reverse       | `reversal`         | `recipient wallet -> club_treasury(club)`                                                                                                                   |
| C2c staff pull    | `club_bank_claim`  | `player_wallet(user) -> club_treasury(club)`                                                                                                                |
| C3a agent send    | `agent_send`       | `agent_wallet(actor) -> player_wallet / agent_wallet(recipient)`, plus `credit_draw credit_facility(actor) -> agent_wallet(actor)` for the shortfall only   |
| C3b claim back    | `agent_claim`      | `player_wallet / agent_wallet(holder) -> agent_wallet(actor)`, plus `credit_repayment agent_wallet(actor) -> credit_facility(actor)` for the repayment only |
| C3c self stake    | `agent_send`       | `agent_wallet(actor) -> player_wallet(actor)`                                                                                                               |
| C3d promo send    | `promo_send`       | `promo_wallet(actor) -> player_wallet / promo_wallet(recipient)`                                                                                            |
| U3c clawback      | `union_settlement` | `club_treasury(club) -> union_bank(union)` (keyed only when an op id is given, as the door itself is)                                                       |

The credit line: the float pays `p_amount - v_shortfall` and `credit_used`
grows by the shortfall, so the send row for the full amount plus a
`credit_draw` row for the shortfall makes the `agent_wallets` trial-balance
line reconcile exactly. `credit_facility` is not in
`fn_ca_noncirculating_chip_stores()`, so a draw shows in `total_supply` the
same way it did before (the chips did appear); whether the facility is an
issuance account is the Mint lane's call. `credit_used` is 0.00 on every
agent today.

Every body was rebuilt from the live `pg_get_functiondef` with lines ADDED
only; a script asserted every live line survives in order before apply, and
the migration's self-check counts each body's refusals (`'success', false`)
and `RAISE EXCEPTION`s against the live numbers (13/1, 11/1, 8/0, 6/0, 14/1,
14/1, 8/1, 13/1, 6/0). Auth checks, the 1e9 ceiling, the 7-day reversal
window, the 10-minute claim-back rule and the credit-line arithmetic are
untouched. Grants unchanged and restated.

## Step 4 - the writer default: CHANGED, on this evidence

`fn_club_members_ledger_writer` no longer invents `table_stack` for an
undeclared write; it says `settlement_suspense`, like `fn_ca_autoledger`.
The third-level fallback (category and counterparty both rejected) said
`table_stack` too and now says suspense.

The verification the brief demanded, run on the live trigger's own rows
before the change:

```
-- rows written by fn_club_members_ledger_writer since Phase 1.x declared the prize legs
select category, from_type, to_type, count(*), count(*) filter (where from_entity_id is null), count(*) filter (where to_entity_id is null)
  from chip_ledger where created_at > '2026-09-02 22:45+00' and description like 'auto-audited club_members.chip_balance delta%'
  group by 1,2,3;
 tournament_buyin  player_wallet  -> prize_liability  31,571  (0 null entities)
 tournament_prize  prize_liability -> player_wallet   12,679  (0)
 buyin             player_wallet  -> table_stack       6,249  (0)
 table_cashout     table_stack    -> player_wallet     3,895  (0)
 rebuy             player_wallet  -> prize_liability   1,689  (0)
 bounty            prize_liability -> player_wallet      778  (0)
 addon             player_wallet  -> prize_liability     459  (0)
 refund            prize_liability -> player_wallet       40  (0)
 adjustment        player_wallet  -> prize_liability       1  (0)
```

57,361 rows in 18 hours, every category the felt produces, and ZERO relying
on the default: each carries a declared counterparty with an entity id
(the default never sets one). The last rows that did rely on it were
`tournament_prize` 2,225 / `refund` 160 / `bounty` 90 between 16:49 and
22:35 on 09-02 - all from paths 20260902224000 declared minutes later. Cash
buy-in and cash-out (8,433 + 5,356 rows / 24h) declared already. The
platform was fully active through the window (~3,000 writer rows per hour).

What changes for a rare undeclared path that did not run in the window
(e.g. `fn_close_settlement_period`'s rakeback credit, which declares a
category but not a counterparty): its row lands `settlement_suspense ->
player_wallet` instead of `table_stack -> player_wallet`. That is the
intended effect - R9 sees it in suspense; it no longer corrupts the
`table_stack` trial-balance line with a felt crossing that never happened.

## Step 5 - rolled-back probes (production, BEGIN ... ROLLBACK, JWT claims set to a real actor)

Club `2a1132b9` (Deep Stack Society), owner `47965354`, agent `060c946d`
(float 130,000), sub-agent `2db815f9` (float 40,000, post-paid, limit
110,000, used 0), player `ed9ff9e2`. Union `fade0000`, member club
`a41434bb`. Balances confirmed unchanged after every probe; zero rows with
the probe keys remain.

**C3a agent -> player, 5.00, as the sub-agent.** before float 40,000 /
player 10,795.86; after 39,995 / 10,800.86; ledger: ONE row
`agent_send agent_wallet(2db815f9) -> player_wallet(ed9ff9e2) 5.00`, key
`agent_send:<op>`, correlation = op; suspense rows 0; table_stack rows 0;
write failures 0.

**C1 / C2a / C2b / C2c as the owner (six calls in one transaction).**
treasury 2,070,942.82 -> 2,070,943.82, float 40,000 -> 39,998, player
10,795.86 -> 10,796.86 (arithmetically -7 -3 +2 +1 +7 +1); ledger, in order:

```
club_bank_send   club_treasury(2a1132b9) -> agent_wallet(2db815f9)   7.00  club_bank_send:<op11>
club_bank_send   club_treasury(2a1132b9) -> player_wallet(ed9ff9e2)  3.00  club_bank_send:<op12>
club_bank_claim  agent_wallet(2db815f9)  -> club_treasury(2a1132b9)  2.00  club_bank_claim:<op13>
club_bank_claim  player_wallet(ed9ff9e2) -> club_treasury(2a1132b9)  1.00  club_bank_claim:<op14>
reversal         agent_wallet(2db815f9)  -> club_treasury(2a1132b9)  7.00  club_bank_reversal:<op15>
club_bank_claim  player_wallet(ed9ff9e2) -> club_treasury(2a1132b9)  1.00  admin_removal:<op16>
```

suspense 0, table_stack 0, failures 0. Six movements, six rows.

**C3a agent -> agent 9.00, C3b partial claim back 4.00, C3c self-stake 6.00,
C3d promo -> promo 4.00 and promo -> player 2.00, as the agent** (owner
first funded the agent's promo float with 10.00 through C1): upline float
130,000 -> 129,989, sub float 40,000 -> 40,005, upline promo 10 -> 4, sub
promo 0 -> 4, upline player wallet +6, player +2; ledger:

```
club_bank_send  club_treasury -> promo_wallet(060c946d)          10.00
agent_send      agent_wallet(060c946d) -> agent_wallet(2db815f9)  9.00  agent_send:<op21>
agent_claim     agent_wallet(2db815f9) -> agent_wallet(060c946d)  4.00  agent_claim:<op22>
agent_send      agent_wallet(060c946d) -> player_wallet(060c946d) 6.00  agent_self_stake:<op23>
promo_send      promo_wallet(060c946d) -> promo_wallet(2db815f9)  4.00  promo_send:<op24>
promo_send      promo_wallet(060c946d) -> player_wallet(ed9ff9e2) 2.00  promo_send:<op25>
```

suspense 0, table_stack 0, failures 0.

**C3a with a credit draw, then C3b full claim back, as the sub-agent.** Send
40,005.00 against a 40,000 float: float 40,000 -> 0, credit_used 0 -> 5,
player +40,005; claim back (NULL = all): float back to 40,000, credit_used
back to 0, player restored. Ledger:

```
credit_draw       credit_facility(2db815f9) -> agent_wallet(2db815f9)      5.00  agent_send:credit:<op31>
agent_send        agent_wallet(2db815f9)    -> player_wallet(ed9ff9e2) 40,005.00  agent_send:<op31>
agent_claim       player_wallet(ed9ff9e2)   -> agent_wallet(2db815f9)  40,005.00  agent_claim:<op32>
credit_repayment  agent_wallet(2db815f9)    -> credit_facility(2db815f9)   5.00  agent_claim:credit:<op32>
```

`agent_wallet` ledger net over the four rows = 0.00 = the float's balance
delta (40,000 -> 0 -> 40,000). suspense 0, failures 0.

**U3c union clawback, 8.00 keyed and 2.00 unkeyed, as the union owner.**
club treasury 1,376,610.47 -> 1,376,600.47, union bank 68,796.84 ->
68,806.84; ledger: `union_settlement club_treasury(a41434bb) ->
union_bank(fade0000) 8.00` with key `union_clawback:<op41>` and `2.00` with
no key (the door accepts a NULL op id and the row says so honestly; the
unkeyed row inherited the earlier correlation only because both calls
shared the probe's transaction, which PostgREST never does). suspense 0,
failures 0.

## Step 6 - apply and mirror

Both migrations applied through `mcp__Supabase__apply_migration`; the
vocabulary one landed inside the :55-:00 scheduled break (platform frozen,
no felt writes in flight), the RPC one at 17:05:29 UTC. Recorded bodies
exported with `/tmp/export-one.mjs` and `cmp`-identical to the files here.
Self-checks in both migrations passed on apply.

## Step 7 - verification in production after apply

- `fn_club_members_ledger_writer`: 564 rows in the ~10 minutes after the
  writer changed, 0 in suspense, 0 write failures; the felt is journaling
  exactly as before.
- Hierarchy categories (`club_bank_send`, `club_bank_claim`, `agent_send`,
  `agent_claim`, `union_settlement`, `promo_send`, `reversal`,
  `credit_draw`, `credit_repayment`) since apply: 0 committed rows, because
  no owner or agent has sent chips yet today (the doors moved nothing in the
  prior 24h either). The rolled-back probes above are the evidence of what
  the first real send will write.
- `settlement_suspense` inflow: 0 rows/hour before (since 09-02 23:00) and
  0 rows/hour after. The trial balance for 16:05-17:05 UTC:
  `settlement_suspense` 0.00 / 0.00 / 0.00, `agent_wallets` 0.00 / 0.00,
  `club_treasuries` -12,717.97 / -12,717.97 / 0.00, `union_banks`
  5,615.56 / 5,615.56 / 0.00, `player_wallets` -12,910.45 / -12,910.45 /
  0.00. (`table_stack` +100.71 and `total_supply` -190.12 are the felt and
  mint lanes' lines, not this one's.)

## Not built, and why

- `fn_union_send_to_club_atomic`, `fn_union_send_chips_to_club`,
  `fn_wallet_claim_back`, `fn_cashier_send_chips`, `fn_cashier_claim_back`:
  orphan doors with no caller (audit F9); another lane revokes them.
  Declaring a door that is about to be closed is noise.
- `fn_member_leave_to_treasury` (C8): the wallet side is journaled by the
  DELETE trigger; the question there is whether a leaving member's chips may
  be confiscated at all (P12), not how to label it.
- The wrappers `fn_agent_wallet_send`, `fn_agent_wallet_claim_back`,
  `fn_agent_wallet_send_phase2_core_20260831` write no balance; untouched.
- Whether `credit_facility` belongs in `fn_ca_noncirculating_chip_stores()`
  (so a credit draw counts as issuance in `total_supply`): a Mint-lane
  decision; the behaviour of that line is unchanged by this work.
