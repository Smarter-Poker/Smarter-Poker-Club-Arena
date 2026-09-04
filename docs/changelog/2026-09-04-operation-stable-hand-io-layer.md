# Operation Stable Hand - IO layer

2026-09-04. Follows `2026-09-04-operation-stable-hand-recon.md`.

## Dan's four rulings, and what each became

**1. "Ignore the 10,000 seed, use their current balances."**
Section 8.1 is retired. There is now deliberately NO seeding primitive in the
module and a test asserts its absence by name. Every horse wallet is already
funded (min 7,420 DSS, 25,000 Midway Union), so a seed could only ever have
overwritten a real balance. `availableOf` subtracts and never adds. Nothing in
Stable Hand creates chips.

**2. "What are you going to do to fix the BRM fail-open?"**
Nothing, and that is the finding. I was wrong to call it a defect.

`resolveSeatClub` already returns null for a horse that belongs to none of a
table's eligible clubs - that is the 261 the telemetry counter was written
about, and they are refused earlier than the branch I flagged. Zero of 1,903
horse memberships carry a null `chip_balance`. The branch is unreachable.

I wired a tightened policy in anyway and two existing guards stopped me:
`HorseBankrollGateClubs.test.ts` and `HorseBankrollTelemetry.test.ts`, the
latter pinning the literal source shape of that branch so nobody can turn the
fail-open back into a refusal. They were right. The fail-open is what kept the
cash floor up for 40 minutes on 2026-08-31, and weakening it to harden a path
that cannot execute is a bad trade. **`HorseFleetManager` is untouched.**

Worth recording: my first draft of the policy keyed on "the load completed",
which is precisely the fact that was TRUE during that outage - the map loaded
"completely" while keyed on clubs owning zero cash tables, so every lookup
missed. A test now replays the incident, and the policy keys on club COVERAGE
instead. It is kept for Stable Hand's own seat path, which enforces the
licence, commit cap, phase clamp and sit caps - none of which
`atomic_table_buyin` can see, so that path cannot inherit the fleet's "the RPC
will catch it" reasoning.

**3. "Omaha 8 is PLO8o, and we should have a handful of limit games."**
`flo8` is Omaha 8 and inherits the PLO8o <= 1/2 ceiling. But limit games get
their OWN cap of 2 and floor of 1 per variant per host: folding them into
`plo8`'s allowance would have taken the fixed-limit floor dark, the opposite of
what was asked. The tagger also tags 8% of the cash fleet for `flh` and `flo8`,
because a table nobody is tagged for can never be seated.

**4. Finish the IO layer.** Below.

## What shipped

| Piece              | Where                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Tag + state schema | `supabase/migrations/20260904060838_stable_hand_tag_and_state_tables.sql`, applied to production |
| Tagger CLI         | `server/src/scripts/horsesTag.ts`, `npm run horses:tag`                                          |
| Floor planner      | `server/src/services/StableHandController.ts`                                                    |
| Dashboard          | `GET /stable-hand` (`server/src/handlers/stableHand.ts`)                                         |
| Freeroll cadence   | `TournamentRecurringService.ts` - 2/day to 6/day                                                 |
| Tests              | 90 across `StableHand.test.ts` + `StableHandController.test.ts`                                  |

Two dedicated tables rather than ~20 columns on `club_members`: that table is
the live chip wallet and every DDL against it costs a ~28s PostgREST schema
reload (CLAUDE.md production DDL policy, the 2026-08-31 PGRST002 outage). One
transaction, one reload, no balance column anywhere.

Tagger dry run against production: 1,580 tags over 1,000 bodies. Coverage
nlh 905, plo4 223, plo5 201, plo6 135, pineapple/short_deck/plo8 112 each,
flh/flo8 90 each, of 1,107 cash tags. Every OPORD floor met.

## A bug the tests caught

T2 ("a worker does not fill the last seat on a ONE_OPEN target") failed on
first run. The occupancy ramp reached for "any table with a free seat", and
`ONE_OPEN` tables are the ones with a free seat by definition - so ramping
toward the curve would have quietly eaten the 20% of the floor a human is
supposed to be able to sit down at. The ramp now only fills tables already
outside a target bucket, and opens a new table when none can absorb it.

## Open for Dan

- **Freeroll spacing and guarantee cost.** The board runs on 3-hour blocks, so
  6 freerolls land at 00/03/06/12/15/18 - gaps of 3,3,6,3,3,6 rather than an
  even 4. Evening it out means 8 a day, which raises guaranteed prize
  liability from 150/day to 600/day. Guarantees are future-event money and so
  Dan's call, not mine (CLAUDE.md 10.9). Left at 6.
- **DSS freerolls.** Section 12 wants a 4-hour cadence on DSS as well. The
  recurring board is owned by `MIDWAY_UNION_ID`; DSS needs its own BoardOwner
  entry. Not built.
- **76 seats above 1/2.** No NEW sit above 1/2 is permitted. The existing 76
  ride until a normal force-leave fires, rather than being torn down.
