# Free Buy guarantees in both rooms

Owner October 22: every day, Morning and Midnight Free Buys guarantee 250;
Midday, Afternoon and Prime Time guarantee 500, including Diamond Arena.

The shared tier defaults still carried the October 16 doubling (500/1,000).
Midway's later structure policy overrode three slots, but Diamond Arena used
the shared creator and therefore kept advertising the old amounts. The shared
slot configuration now supplies the guarantee to both original creators and
the board audit. Existing capacities, purchase prices, stacks and times stay.

The existing fixed-board law covers 70 room/day/slot cases, including Diamond
spawn conversion. Before the change, 21 cases failed; all 70 now pass. The
existing Free Buy tests pin the reduced default tiers and 2,000 daily total.

`scripts/ops/free-buy-guarantees.sql` is an explicit, idempotent business-data
operation for existing eligible listings. It locks each parent, takes a fresh
read, refuses maintenance, and skips entrants, locked/finalized/funded pools,
started events, paid entries and foreign rooms. It changes only the guarantee.
All installed safeguards remain enabled. Original Diamond house earmarks and
custody remain intact; this operation neither releases nor moves funds.

Run `node scripts/qualification/free-buy-guarantees.mjs` with an isolated local
PostgreSQL instance on port 55489 (override FREE_BUY_QUAL_PORT if necessary).
It creates and drops its own database on loopback, qualifies the exact SQL,
uses the maintained first-entrant trigger, and exercises 70 eligible cases,
14 protected boundaries, replay, maintenance refusal and real registration
concurrency. No production URL is accepted.

Production's self-aborting qualification changed exactly two eligible Diamond
listings (Sunday Morning 500 to 250 and Sunday Prime Time 1,000 to 500), with
no other tournament fields changed. The exact operation was then applied and
both guarantees read back. Existing registered events retain their terms.

Required protected checks, merge, routine daily engine activation, exact
serving identity and final live-app evidence are separate delivery stages.
The existing 04:00 America/Chicago activation rule is preserved.
