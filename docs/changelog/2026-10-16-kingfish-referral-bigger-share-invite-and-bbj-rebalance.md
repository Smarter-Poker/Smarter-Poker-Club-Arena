# 2026-10-16: KingFish's referral ID, a bigger Share & Invite, and the BBJ rebalance

Dan, verbatim: "share and invite are way too small. make it larger. and change
my "referral ID from "1" to "KingFish" im the only one that should have there
reference ID as a name, everyone else uses player number. 2, reduce the BBJ
down to $7,777.77 for now, and remove 100% of the back up bbj and 75% of the
promo chips and send them all to the union main bank."

## 1. Share & Invite is larger

The words were fitted into the master's painted blue plate (325 x 66 master
px), and in Inter at 0.04em tracking "SHARE & INVITE" fitted down to about
2.2cqw. A bigger font alone would have hit the rim, so the plate itself grew.

- New art `public/assets/club-buttons/club/kingfish-v1/chassis-share-plate-v2.png`,
  cut from `chassis.png` by surgery: the plate's native end caps, the face's
  own median cross-section tiled across the middle, its own vertical gradient
  re-spaced, composited back through a mask of the face so the brushed
  background around it is untouched. The plate is ~40% wider and ~35% deeper
  (face x 910-1383, y 459-556 on the 1566 x 672 master), centred where it was.
  `chassis.png` is untouched: it is byte-sealed for tabs holding old bundles.
- `CLUB_IDENTITY_ZONES.invite` re-measured to the new face; `arenaStats`
  widened (494 -> 540, 184 -> 190) so the Diamond Arena's opaque rail still
  covers every painted pixel of the plate.
- The label prints in Roboto Condensed (the master's chrome face, the one
  PLAYING NOW is painted in) at up to 5.2cqw: well over twice the old size.
- Tap behaviour unchanged: the words are still the label inside the one share
  button, so the 44px thumb band and the single keyboard stop are as before.

Rendered at 393px before/after, club and arena states.

## 2. KingFish's referral ID is "KingFish"

Player number has been the club referral ID everywhere (`profiles.player_number`).
Player 1 is now the one exception.

- `src/lib/referralId.ts`: `referralIdFor()` gives "KingFish" for player 1
  and the player number for everyone else; `playerNumberForReferralId()` maps
  the name back (any case).
- Lobby card prints and copies it (toast "Referral ID Copied" for the name).
  Club Settings' "Referral Code", Promotions' share code and fallback `?ref=`
  link, and the agent invite modal's `?ref=` all use it.
- `AgentService.linkPlayerByReferral` resolves the name for its toast.
- Migration `20261016232523_kingfish_referral_id_resolves_to_player_one`:
  `fn_redeem_club_invite_code` (the door every typed or linked code passes
  through) maps "kingfish" to "1" before resolving, so a friend who types
  KingFish lands on Dan and every first-link, self-referral and membership
  check runs as for a number. The body is the live 20261016042212 definition
  copied from file bytes with one inserted block, behind an md5 preimage guard.
  "1" still works.

## 3. BBJ to 7,777.77, backup and 75% of promo to the union main bank

Migration `20261016231936_owner_moves_bbj_backup_and_promo_to_union_bank`,
one data-only DO block for the Midway Union pool:

| Move | Source | Amount |
| --- | --- | --- |
| BBJ main above 7,777.77 | `bbj_pools.main_balance` | read under lock at apply |
| 100% of backup | `bbj_pools.backup_balance` | read under lock at apply |
| 75% of union promo | `union_wallets.promo_wallet` | read under lock at apply |

All into `union_wallets.chip_balance`, category `treasury_transfer`, one
correlation id, idempotency keys `owner-bbj-promo-to-union-bank-20261016:*`.
Shape follows the scoped launch reset's BBJ step for the two pool moves and
the mirror of `fn_spin_reserve_wallet_fund` for promo -> bank. Probed twice
in self-aborting DO blocks with `SET CONSTRAINTS ALL IMMEDIATE`: every
commit-time ledger check passed, BBJ conservation stayed healthy (drift -9.82,
unchanged), treasury selftest healthy with no breaches, promo bank reconciles.
Applied figures are recorded in the PR.

"Promo chips" is read as the union Promo Wallet, the balance the dashboard
labels as promo; the pool's in-transit promo bank (17.74, swept every five
minutes) was left alone.

Consequences of the request:

- The Mini pays out of the backup bank, so it has nothing to pay until
  contributions refill backup.
- The Midway weekly horse promo budgets half of the promo wallet at each
  close, so the first run (week ending Oct 19) is a quarter of what it would
  have been.
- `bbj_pools.main_balance` keeps taking contributions, so the displayed BBJ
  starts climbing again from 7,777.77 immediately.
