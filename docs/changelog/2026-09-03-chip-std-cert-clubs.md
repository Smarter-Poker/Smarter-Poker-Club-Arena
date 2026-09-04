# The test clubs are gone, and the certification stops making more

2026-09-03, on Dan's ruling 2.

> "THERE HAVE NOT BEEN 13 CLUBS CREATED IN 30 DAYS, IF THEY WERE THEY WERE 'TEST
> CLUBS' THAT NEED TO BE DELETED. THE ONLY CLUB ARENA CLUBS ARE 'MIDWAY UNION'
> WHICH IS A UNION, NOT A CLUB, CLUB JAQK, SHARK CLUB, AND DEEP STACK SOCIETY.
> DELETE ANY OTHER CLUBS."

He was right, and my earlier report was wrong to describe them as clubs. They
were Club Create Certification fixtures, and the count came from a leak.

## Why 15 fixtures were standing

The certification creates a throwaway club on every run and deletes it again in
a `finally` block. That delete has failed **every single time** since
2026-08-31, and the script only warned:

    Fixture Hard Delete Skipped: UPDATE on chip_transactions is forbidden:
    financial journals are append-only.

Three guards stand between a club and deletion, and all three are correct:

1. `clubs -> chip_transactions` is `ON DELETE SET NULL`, which is an UPDATE on an
   append-only journal, which the journal refuses;
2. `chip_transactions.club_id` is `NOT NULL`, so that SET NULL could never have
   worked anyway - the foreign key and the column have disagreed since the day
   the journal was made append-only;
3. removing the last member emits a management-access event pointing at the
   club, and `game_management_events` is append-only too.

So each run left a club behind holding its 100,000-chip opening grant: **15
clubs, 1,300,000 chips**, all inactive, no tables, no tournaments, one
`@smarter-poker.invalid` member each.

## The sanctioned door

`fn_ca_retire_certification_club(club_id, reason)`:

- refuses anything that is not a fixture - it must match the certification
  naming **and** have no union, no tables, no tournaments, no agents, and no
  member who is not a cert account holding zero chips;
- refuses Club JAQK, SHARK CLUB, Deep Stack Society and Midway Union **by id**,
  so a rename can never point it at a real estate;
- retires every chip the fixture holds to `chip_retirement` with a declared
  journal row, so the supply meter reads a burn rather than a leak - the exact
  mirror of the Mint issuance that opened the club;
- opens both append-only doors by name (`app.ledger_maintenance`, which
  preserves each journal row whole in `ca_ledger_mutation_log` with the reason
  attached and raises its own warning incident, and
  `app.game_management_retention`), and closes them again;
- deletes in the order the foreign keys require: journal rows, then members,
  then the events their removal emitted, then the club.

It is `service_role` only.

## What happened in production

The migration swept the backlog and asserted the result before committing:

- **15 fixtures retired**, 1,300,000 chips returned to the Mint across 13
  declared `chip_retirement` burn rows;
- 13 journal rows archived in `ca_ledger_mutation_log` under
  `cert-cleanup-backlog:<club id>`, with one warning incident raised by the
  maintenance door, as designed;
- `clubs` now holds exactly four rows: Club JAQK, SHARK CLUB, Midway Union and
  Deep Stack Society. The migration refuses to commit if it is any other number.

The first attempt at 22:58 UTC was refused by the scheduled maintenance break
(:55 to :00, which freezes writes on `chip_transactions`). Nothing was
half-applied - the whole migration is one transaction - and it was re-applied at
23:03.

## The leak is closed

`scripts/ci/certify-club-create.mjs` now calls
`fn_ca_retire_certification_club` for each fixture instead of
`.from('clubs').delete()`, reports the chips it returned to the Mint, and
**throws** if any fixture survives. A leaked fixture is a failing certification
run from now on, not a warning nobody reads.

## Files

- `supabase/migrations/20260903230339_a_certification_club_is_retired_to_the_mint_and_then_it_is_gone.sql`
- `scripts/ci/certify-club-create.mjs`
- `tests/only-the-real-clubs-exist.law.test.ts`
