# Satellites seat bounty targets (2026-10-16)

Dan, 2026-10-16: "EVERY TOURNAMENT WITH A 25 BUY IN OR HIGHER SHOULD HAVE
SATELLITES INTO IT."

## What was wrong

A satellite could not feed a bounty, PKO or mystery-bounty event. The engine's
`satelliteTargetIsDeliverable`, the client's satellite target picker,
`fn_satellite_target_is_deliverable` (with its trigger) and
`fn_ca_satellite_target_accepts_new_feeder` all refused to open one, and both
settlement authorities (`fn_settle_satellite_tournament_pre_money_path_gate`,
`fn_ca_settle_satellite_cohort`) refused such a target at the finish
("uses an unsupported bounty or Spin entry split").

The refusal was there for a real reason. The seat leg booked the whole ticket
as prize (`satellite_in`) and the seat row carried no `current_bounty`, so
`trg_seed_bounty_head` raised the bounty pool by a head nobody had paid for.
That is the 2026-09-04 Sunday Funday High Roller PKO: 66 entrants owed
max(3,500, 66 x 32.50) + 66 x 35.00 = 5,810.00 and handed 4,455.00.

## What changed (migration `20261017004440_satellites_seat_bounty_targets`)

A seat into a bounty target is now booked exactly like a paid entry, split by
the paid door's own `fn_tournament_entry_split`. For a target whose split
carries a bounty (a plain target is booked exactly as before):

- the seat row carries `current_bounty` = the bounty slice
  (`mystery_bounty_value` 0, as the paid door writes it), so the seed trigger
  never books an unfunded head;
- the pool-transfer leg names its split (`entry_split_version` 2,
  `entry_prize`, `entry_bounty`, `entry_fee`) and its fee row carries the v2
  tag, so the existing escrow triggers book `gross_in` = prize + bounty,
  `bounty_in` = bounty and `satellite_fee_in` = fee;
- the target's `prize_pool`, `bounty_pool` and `total_rake` move by the split
  and the authority proves the escrow moved by exactly the same amounts;
- the seat's refund entitlement returns prize, bounty and fee from the
  `satellite_gross` bucket the refund plan already reads;
- a four-table-cap winner's noncash ticket carries the split, and redemption
  and the ticket finder accept it (target buy-in = ticket prize + bounty);
- both receipts accept a bounty target and require every seat leg and ticket
  to carry the exact split.

Still refused by name: Spin and premium Spin targets, unknown (NULL) flags, a
bounty larger than the buy-in, and a Diamond bounty target (the Diamond seat
transfer has no bounty part). A satellite is still never itself a bounty or
Spin event: the engine's restart path now asks the new
`satelliteSourceIsSupported` for that source rule instead of the target
predicate.

## A correction to the design as first written

The target pre-check was going to require `bounty_balance = bounty_pool`.
Production, read 2026-10-16: all 89 REGISTERING bounty events satisfy it, but
all 3 RUNNING ones hold `bounty_balance = bounty_pool - bounty_pool_paid`,
because a knockout pays from the bank. That check would have refused every
late seat into a running PKO after its first knockout. The pre-check is
`bounty_pool - bounty_pool_paid`; the qualification proves a late seat after a
knockout.

## Proof

`scripts/ci/test-satellite-bounty-seat-split.py` (PostgreSQL 17, 85 checks)
runs the migration's own postimages over production's exact escrow triggers,
escrow reconstruction, refund plan, seed trigger and mystery chest seed:
production's preimage refuses the PKO; 66 seats into the 2026-09-04 PKO shape
end funded at exactly 5,810.00 (prize 2,145.00, bounty 2,310.00 in 66 funded
35.00 heads, fee 495.00), with escrow equal to the counters and to
production's reconstruction, every entitlement in `satellite_gross`, the
refund plan agreeing and the receipt replaying; a capped winner's ticket
carries the split and the finder offers it; mystery chests are built from a
pool that counts the seats; a plain target is booked exactly as before; every
refusal above still fires before any write; every postimage installs to the
md5 its `@live-proof` line declares.

Law: `tests/a-satellite-seats-a-bounty-target-like-a-paid-entry.law.test.ts`.

## Not done here

- `fn_ca_settle_satellite_cohort`, `fn_ca_satellite_cohort_receipt` and the
  two ticket doors carry the same replacements but were compiled and hashed,
  not executed, by the qualification (their other dependencies are not in its
  cluster).
- The heads-up feeder still feeds only the `SATELLITE_HU_TARGETS_PER_OWNER`
  (3) dearest targets per owner; "every tournament at 25 or more" is about
  which targets are eligible, which this change fixes, not how many feeders
  the board opens.
- As read (not executed), the ticket door's own pre-check compares
  `current_players` to the live (registered or playing) roster count, while a
  RUNNING event's `current_players` is its total entrant count, so a late
  ticket entry into a running event after its first bust would be refused as
  "divergent tournament escrow". That predates this change and affects plain
  targets equally; it is reported, not changed.

## Review fixes and the rebuild (2026-10-17)

An independent review returned two fixes, both made:

- The ticket door compared `tournaments.bounty_pool` with the escrow's bounty
  bank. A running bounty event's bank is its pool less what knockouts have
  paid (`bounty_pool_paid`), so a late ticket seat after the first knockout
  was refused. It now compares against `bounty_pool - bounty_pool_paid`, as
  both settlement authorities do.
- The engine could choose a Diamond Arena bounty target that the database
  refuses. `SatelliteTargetRow.diamond_host` is set by both callers from the
  host club's own row, and a bounty target is deliverable only when it is a
  known false.

Before install, production was read again and two preimages had moved:
`20261017033733_a_capped_diamond_satellite_winner_is_paid_not_held` (another
session) changed both settlement authorities. Their new text was rebuilt from
production by line hash and proved equal to production's md5 (`8fb5cdbc...`
and `22063fc9...`), and the postimages were regenerated from it. The law test
pins both of that migration's rules in the postimages so this one cannot
restore the older text, and the capped-winner fixture now loads five seats
(four games plus the satellite chair the settlement releases). Harness: 85/85.

## The satellites themselves

`*_satellites_into_the_bounty_events` adds fifteen Midway Union satellite
schedules, on the :15 and :45, into the Union Mystery Bounty, the Union Grand
Championship, the 33 weekly bounty nights and the seven Sunday Funday bounty
events, and asserts that every active Midway event of 25 or more now has a
satellite. The Diamond Arena's bounty events stay unfed (no bounty part in the
Diamond seat transfer).

The bounty migration is 296 KB, so it is installed from its own bytes by
`apply-merged-migration.yml` after merge rather than retyped into a tool call.
