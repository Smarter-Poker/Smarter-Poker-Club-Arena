# Weekly Commission Lands In Agent Wallets And The Owner Share Stays In The Club Bank

Owner rules (Dan, 2026-10-22, binding):

1. Agent commission always goes to the agent's agent wallet
   (`agents.agent_wallet_balance` for that club and user), never to the player
   wallet (`club_members.chip_balance`).
2. Players with no agent belong to the club owner.
3. The club owner never receives agent commission into any personal wallet.
   The owner's share stays in the club bank (`clubs.chip_treasury`).
4. Rakeback owed to players whose agent is the owner, or who have no agent, is
   paid from the club bank, never from the owner's wallet.
5. Rakeback a real agent owes its players, and commission it passes down to
   child agents, come out of that agent's agent wallet. Agents are prepaid.

## What Was Wrong

Round 2 (`fn_settle_accounting_commission_stage` and its v3 fallback) credited
every payee's `club_members.chip_balance`, so commission landed in player
wallets platform wide every week (about 1.85M in the week of 2026-10-19). The
club owner was treated as the top agent: in KINGS CLUB the owner received
11,689.56 (2026-10-17) and 7,427.40 (2026-10-22) of club bank chips into his
player wallet, and Round 3 then paid 12,673.88 of his players' rakeback out of
that player wallet. The net 6,443.08 was returned to the club bank by hand on
2026-10-22 (claim-back op 6f2b4b7e-3c1a-4d0e-9a51-2c7e0b8f6443) and is not
moved again here.

## What Changed

Migration `20261022164439_weekly_commission_lands_in_agent_wallets_and_the_owner_share`
replaces six function bodies, each derived from its exact installed definition
(md5 pinned; the install refuses on drift) and verified by postimage md5:

- Round 2 removes the owner's own tier from the transfer plan, pays what the
  hierarchy passes down through the owner straight from the club bank to the
  child agent, and credits every other payee's agent wallet with one
  `club_treasury|agent_wallet -> agent_wallet` ledger leg and receipt. Its run
  receipt records `owner_retained_in_club_bank`.
- Round 3 records where each certified payer share is funded from: the club
  bank for a club, no-agent or owner share, otherwise the agent's agent wallet.
  The certificate's payer identity is unchanged.
- `smarter_private.split_rakeback_payout_complete` accepts the agent-wallet and
  owner-share-from-bank legs of a split payout.
- `fn_ca_deleted_wallet_bank_return` holds published rakeback back in the agent
  wallet first, and `fn_ca_deleted_wallet_credit` defers a deleted agent's
  agent-wallet credit inside the commission stage, as it did for member wallets.

Invoices, the weekly club summary, the agent weekly statement, cashier
statements, the settlement correctness check, the payout guarantee check, the
union cascade and its conservation assert already accept `agent_wallet` and
`club_treasury` legs; none needed a change. Forward only: no past week is
settled or replayed, and no historical row changes.

## Evidence

- Native PostgreSQL 17 regression `scripts/ci/test-commission-agent-wallet-postgres.py`
  loads the exact live preimages, reproduces the defect, installs the migration
  file whole and proves all five rules, the funding refusals, the deleted-agent
  bank return and ledger conservation. It runs in accounting CI shard 1 through
  `scripts/dev/test-agent-accounting-statements.sh`.
- Rolled-back production probes: Round 2 over the union's 2026-10-22 07:00 to
  09:00 UTC sources (51,532 sources, 33 payees), both before install and on the
  installed function, paid 64.69 into agent wallets with 33 agent-wallet legs
  and 33 receipts, wrote no player-wallet commission leg, kept the KINGS CLUB
  owner's 15.98 in the bank with the owner's wallets unchanged, and the
  settlement correctness check raised 0 incidents. Round 3 over 64 cloned KINGS
  CLUB periods of the 2026-10-12 week paid 17,545.25 from agent wallets, 4,895.61
  of owner shares and 808.27 of no-agent shares from the club bank, debited no
  player wallet and left the owner's agent wallet unchanged; all 25 split
  payouts passed the new completeness check.
- Installed 2026-10-22 19:26 UTC; live proof true; recorded in
  `supabase_migrations.schema_migrations`.
