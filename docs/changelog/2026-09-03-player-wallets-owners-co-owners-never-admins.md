# 2026-09-03: Owners and co-owners hold a player wallet, admins never, clubs only

Dan: "All club owners and co owners should have a player wallet. add player
wallets now to all those roles for clubs only, not for unions. admin's should
never have a player wallet. add this in for all current clubs, and new clubs
that haven't been created yet."

## What a player wallet is

`club_members.chip_balance` on the member's own row in that club
(`WalletService.ts`: PLAYER = `club_members.chip_balance`). There is no
separate wallet table to populate. Holding a player wallet therefore means:
an ACTIVE membership row exists for that user in that club, and the role is
one allowed to hold chips there.

## What already existed

2026-09-02 (#2719) put the rule in two places: `walletRows.ts` shows the
Player Wallet row to every role except `admin`, and `fn_club_bank_send`
refuses a `player_wallet` credit to an admin. Both are live in production
(`ca_sha` 9d1d30dd7 contains bad7edc32).

## What was missing

The rule lived in one TS file and one RPC, not in the data:

- an owner whose authority comes from `clubs.owner_id` with no `club_members`
  row had nothing to hold chips in — `fn_my_wallet_ledger` already synthesises
  `role := 'owner'` for that case, so the codebase knew the shape existed;
- every other money path (`fn_agent_wallet_send`, `fn_promo_wallet_send`,
  engine cash-outs, any future RPC) could still credit an admin's
  `chip_balance`, where no surface would ever show it — the stranded-chips
  class of bug that `fn_club_bank_send` alone was guarding against.

## `20260903200000_owners_and_co_owners_hold_a_player_wallet_admins_never.sql` (applied)

1. `fn_has_player_wallet(club, user)` — the one predicate: active membership,
   role <> 'admin', club is not a union house row.
2. `trg_club_owner_has_a_player_wallet` on `clubs` — every owner gets a
   membership row (role `owner`, status `active`, **chips 0**) on INSERT and on
   ownership transfer. An existing but dormant/underprivileged owner row is
   raised to active owner instead.
3. `trg_admin_holds_no_player_wallet` on `club_members` — refuses any write
   that would leave an admin with a positive `chip_balance`
   ("An Admin Does Not Hold A Player Wallet"), and refuses promoting a
   chip-holding member to admin ("Cash Out The Player Wallet Before Making
   This Member An Admin"). Every money path hits this, not just the one that
   remembered.
4. Backfill + assertions: zero owners without a wallet, zero admins holding
   chips, both guards attached.

Unions untouched: both guards return early when `clubs.is_union`, and no
union table is read or written. A union house club row gets no membership.

### Two things learned applying it

- **The clubs trigger must be DEFERRED.**
  `fn_create_club_atomic_membership_impl` inserts the owner's membership with a
  **bare INSERT, no ON CONFLICT**. An immediate AFTER-INSERT trigger would
  create that row first and the creator's own INSERT would then fail on the
  unique key — club creation would have broken for everybody. Deferred to
  commit, the trigger sees the row the creator already made and does nothing.
- **Never `DROP TRIGGER` on a hot table.** It takes ACCESS EXCLUSIVE and
  deadlocked against live traffic. `CREATE OR REPLACE TRIGGER` takes SHARE ROW
  EXCLUSIVE — but it is **not supported for CONSTRAINT triggers**, so this one
  is created inside an existence check instead.

## Probe (CLAUDE.md 11.5 — executed in a transaction, rolled back)

| Case                                                          | Result                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| club row created with no membership path                      | `owner/active/chips=0.00` created at commit                              |
| `fn_create_club_atomic` shape (club + bare membership INSERT) | 1 row, role `owner` — no collision                                       |
| union house club row                                          | 0 memberships created                                                    |
| credit an admin's player wallet                               | refused: "An Admin Does Not Hold A Player Wallet"                        |
| co-owner holds chips                                          | allowed, 750.00                                                          |
| promote a chip-holding member to admin                        | refused: "Cash Out The Player Wallet Before Making This Member An Admin" |

Nothing persisted; verified afterwards that no probe rows remain.

## Production state after apply

3 non-union clubs, all 3 owners hold a player wallet; 1 union house row, no
memberships; 0 admins holding chips. There are currently no co-owners or
admins on the platform — the guards are what make the rule true for the ones
created next.

## Deliberately not changed

- **The wallet starts empty and stays that way until the owner funds it.**
  `20260901004500_opening_club_bank_is_not_drift.sql` is explicit that opening
  chips belong in `clubs.chip_treasury`, never the owner's wallet.
- **`fn_my_wallet_ledger` still returns a `player_wallet` balance for any
  member.** It is `auth.uid()`-scoped and an admin's `chip_balance` is now
  provably 0, and admins cannot reach the modal because the row is not
  rendered. Rewriting a 3.5KB read function for a value that can only be zero
  is risk without benefit.
