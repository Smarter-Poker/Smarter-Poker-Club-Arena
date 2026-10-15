# Horse Wallets Reset To 10,000; Human Chips Returned To The Club Banks

Dan, 2026-10-15: "Shut down all the tables at the next hour break for a full
hour, claim back all horse chips from all clubs to the main bank, then send
all horses 10,000 chips each", then "pull all chips from all humans back to
the main bank as well. Only horses should have chips at the moment."
Dan's answers before it ran: horses only for the reset, 10,000 in every club
a horse belongs to; then every human wallet to zero.

## The Shutdown (16:52 to 18:11 UTC)

- 16:52 `ca_horse_fleet_policy` global row set `enabled = false`: no new
  horse seats or tournament registrations.
- 16:53 operator `park` 3d9c1ba1, scoped (ca_launch_operator_scopes) to cash
  tables only, so tournament seating was never refused.
- 17:01 operator `close_cash` fb484cc1: all 115 cash tables closed through
  the engine's own boundary close; 0 seats left on the cash floor.
- 17:41 hold renewed once (an off-cycle Deployment Recovery freeze
  interrupted the run).
- 18:10 `resume` b930a4a2 through `fn_ca_launch_operator_command` (resume
  receipts for every closed table); 18:11 fleet re-enabled.
- Running tournaments were left to finish: an hour's floor hold does not stop
  their blind clocks.

## The Reset

Every move went through the cashier's own idempotent doors as Dan's owner
account: `fn_club_bank_claim_back` (player wallet into the club bank) then
`fn_club_bank_send` (10,000 to the player wallet), reason "Owner Horse Wallet
Reset To 10,000 (Dan, 2026-10-15)", keys `horse-reset-20261015:*`.

| Club               | Live horses at 10,000 | Claimed into the bank | Sent      |
| ------------------ | --------------------- | --------------------- | --------- |
| Deep Stack Society | 416                   | 6,330,829.27          | 4,160,000 |
| Club JAQK          | 518                   | 78,122,251.16         | 5,800,000 |
| SHARK CLUB         | 522                   | 48,902,694.31         | 5,840,000 |
| Midway Union       | 261                   | 20,008,734.19         | 3,230,000 |

1,717 live horse wallets held exactly 10,000 at 18:09 UTC. 186 deleted horse
accounts (62 in each of three clubs) were sent 10,000 before they were
excluded; the platform's deleted-account sweep returned each one to the same
club bank within minutes, so they net to zero and both legs are on the ledger.

Lightning Internal Pilot (72 horses, 14,516 chips) was not reset: Dan is not a
member, it is the Lightning calibration pilot, and its bank (84,830) cannot
fund 720,000 without a mint.

## Human Chips

At 18:21 UTC every human position was claimed into its club bank in one
transaction (`human-reset-20261015:*`): 14 claims, 248,503.29 chips across
player, agent and promo wallets. Every human wallet then read 0.

Play resumed at 18:11, so horse balances move from 10,000 with normal play.
