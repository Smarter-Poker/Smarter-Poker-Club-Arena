# A deleted account leaves every club and every list (2026-10-16)

## Dan's instruction

> remove any and all deleted player from appearing inside of any searches or
> cashier pages or anywhere for that matter. for all clubs and unions. once
> they are deleted, they should be removed for good, not linger as a deleted
> stat. if they still have chips, those chips get recorded in the ledger and
> sent back to the main bank.

His screenshot was the Midway Union player directory listing
`Deleted-217ac35a5922 / Club JAQK / AGENT` and six more like it.

## What was wrong, read from rows

- 1,323 profiles hold `status = 'deleted'`. 1,261 were closed through Close
  Account and hold no club rows. The other 62 are the patterned-id identities
  that `scripts/admin/retire-patterned-identities.sql` tombstoned on
  2026-10-06. That retirement set the profile status and never ended a
  membership: all 62 still held **186 active memberships** (Club JAQK, SHARK
  CLUB, Midway Union) and **24 active agent rows**, and **245 live members**
  and **17 live agent rows** still pointed at them as their upline.
- The cause: nothing made a deletion end a membership. `fn_close_account`
  departs its own clubs before it deletes, but any other path that sets
  `status = 'deleted'` left the person a full member and agent. The October 10
  work hid deleted profiles from the cashier and some rosters one list at a
  time; every list reading `club_members` or `player_stats` directly still
  showed them.
- Measured as the owner in a self-aborting probe: the union directory returned
  62 deleted accounts (372 tombstone names), `ca_club_members` 17 (JAQK) and 20
  (SHARK), `ca_club_members_page` carried 9 and 14 deleted upline ids, and the
  all-time JAQK leaderboard ranked 55 deleted accounts in its top 500.
- Chips: every deleted account's club wallet, agent wallet, promo, credit and
  held/locked balance was already 0. The October 10 migrations returned their
  free club chips to each main bank through ledgered receipts, and
  `zzzz_deleted_*_credit` returns any later credit inside its own transaction.

## The fix (migration `20261016224731_a_deleted_account_leaves_every_club_and_every_list`)

1. `fn_ca_deleted_account_leaves_every_club(user)`: in every active club it
   returns free club chips to the main bank through the existing ledgered
   `fn_ca_deleted_wallet_bank_return`, refuses the deletion if any other
   custody would be stranded, moves live downline and agent children to the
   nearest live upline, suspends the account's agent rows and departs every
   membership exactly as Close Account does (audit_trail row, lifecycle
   columns). Idempotent.
2. `zzzzz_deleted_profile_leaves_every_club` runs it in the transaction that
   deletes the account, after `zzzz_deleted_profile_bank_return`. Every
   deletion path now ends every membership; no sweep, no cron.
3. The union player directory, `ca_club_members` and the six leaderboard
   ranking owners (club, union, global and diamond period, club and global
   by-dates) exclude `status = 'deleted'` before ranking, so ranks are over
   live accounts. `fn_payout_leaderboard` reads the same owner, so a deleted
   account is never paid a place and the live player shown in it is.
4. The 62 existing accounts were settled through (1): 186 memberships
   departed, 24 agent rows suspended, 245 members and 17 agent rows re-homed,
   0.00 chips left to return (asserted from the accounts and from this
   transaction's own bank receipts, not a bank total that live play moves).

Profile status decides deletion; nothing tests player type or name.

## Proof

One self-aborting production probe built every function in `pg_temp`, ran the
settlement and measured each list as the owner: board 62/186/24, re-homed 245,
re-parented 17, repeat 0, free chips before and after 0.00, receipts 0. After
it, every patched list returned 0 deleted ids and 0 tombstone names, while the
unpatched live leaderboard (the control) still returned 55.

Pinned by `tests/deleted-accounts-leave-every-club.law.test.ts`.

## Not changed

`public.wallets` is the retired global pool (`WALLET_POOL_RETIRED`, October 5).
The 62 accounts hold 1,524,176.95 there, untouched since 2026-08-20, as do
many live players. It belongs to no club and no screen reads it, so moving it
into a club bank would mint club chips that never existed in that club. It is
left exactly as it is.
