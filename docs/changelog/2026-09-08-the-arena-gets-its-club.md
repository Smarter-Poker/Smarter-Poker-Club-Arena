# Phase 5.1: the Diamond Arena gets its club, and creating it mints nothing

2026-09-08. `supabase/migrations/20260908114501_the_arena_gets_its_club.sql`.

The arena's accounting foundation was built earlier the same day and deliberately
stopped one step short: `clubs.asset`, `clubs.is_platform`, `ca_arena_settings`,
`fn_arena_deposit` / `fn_arena_withdraw`, `fn_ca_arena_diamonds()` and two
log-only rules all existed, and no club did. `ca_arena_settings.club_id` was
NULL and its own note said "club_id is set when the arena club is created".

## Creating a club mints 100,000 chips, and that had to be stopped first

`fn_seed_new_club_opening_bank` is a BEFORE INSERT trigger on `clubs` that sets
`NEW.chip_treasury := 100000` for every club that is not a union -
unconditionally, with no reference to `asset`, because when it was written there
was only one asset. The auto-ledger then journals that treasury into
`chip_ledger` as `issuance_reserve -> club_treasury`, and
`fn_record_new_club_opening_bank` writes the matching mint of **100,000 chips**
into `ca_mint_ledger`.

Inserting the Diamond Arena unchanged would therefore have created a hundred
thousand chips inside a club whose asset is diamonds, registered them against the
chip supply, and left the chip books carrying a club that plays in another
currency. Nobody would have asked for it and nothing would have refused it: the
grant is a courtesy for a new customer club, and the platform club is not a
customer.

Both functions return early now for any club whose asset is not `chips`. The
house is funded the way the standard says (3.2, arena item 4) - through
`fn_ca_mint(diamonds, destination = house)` - not as a side effect of INSERT.

## What was created

- One club, `Diamond Arena`, `asset = diamonds`, `is_platform = true`,
  `union_id NULL`, owned by the platform service identity (`smarterpoker`, role
  god) and never by a person (CLAUDE.md 10.10 rule 2). That is also the uuid the
  chip auto-ledger already uses as its actor of last resort, so the books name
  the same entity.
- **Every balance written to zero explicitly** - treasury, pool, promo,
  insurance, rake - so the auto-ledger wrote no row at all (it skips a zero
  delta) and the club began holding nothing. The migration asserts that the chip
  supply and the diamond supply are both unchanged by its own INSERT.
- A partial unique index, `ca_clubs_one_platform_club`. Ruling 16 and the
  standard both say ONE platform club; until now nothing made that true.
- The owner's `club_members` row, created through the declared source
  `club_owner_create` - memberships may only be made by a declared source, and
  this is the one that source exists for.
- `ca_arena_settings.club_id`, which switches on `fn_ca_arena_diamonds()`, both
  arena doors and the cross-asset seat guard; all of them read that row and
  returned early while it was NULL.

## What this is not

No table, no tournament, no diamond, no rake, no horse. The entry condition for
a diamond table opening is unchanged and is not met: seven consecutive days of
`fn_ca_diamond_trial_balance` at zero on every account, suspense zero, and no
open critical incident. Creating the club is what lets the reporting surfaces be
written against something real.
