# 468 horses were being treated as test equipment, because of their email address

2026-09-08. `supabase/migrations/20260908134732_a_horse_is_not_test_equipment.sql`
and `20260908134818_a_horse_collects_its_daily_bonus.sql`.

Dan, the same day: horses "NEED TO BE INCLUDED AND AWARDED DIAMONDS JUST LIKE ANY
OTHER USER WOULD BE."

## How it was found

An assertion refused to pass. I was opening the daily bonus to the engine so a
horse could collect one, and wrote a check that a horse is eligible. It failed -
in a function whose own comment reads _"Horses are players (Diamond Accounting
Standard D22). Fixtures are not."_

Somebody had already decided this deliberately and written it down. Something
else was quietly overruling them.

## What was true

`fn_ca_is_cert_account` decides who is certification equipment rather than a
player, and it matched horses two ways by accident:

| Route                                                          | Horses caught |
| -------------------------------------------------------------- | ------------- |
| `email LIKE '%@horses.smarter.poker'` - the fleet's own domain | **416**       |
| `uuid LIKE '00000000-0000-0000-0000-%'`                        | **52**        |
| An active row in `ca_cert_accounts`, the deliberate register   | **0**         |

468 of 1,000 horses, holding **1,324,300 diamonds** - 40% of everything the fleet
owns - were classified as test equipment by nothing more than the shape of their
address. No non-horse is on that domain, so the domain is nothing but horses.

**Eleven functions consult that predicate**, and every one treated those horses as
not-players:

- `fn_ca_daily_bonus_eligibility` refused them the daily bonus outright
- `fn_wheel_spin` and `fn_diamond_game_admit` refused them the wheel and the games
- `fn_ca_duel_pairing_scan` left them out of duels
- **`fn_ca_collusion_scan` left them out of the integrity scan** - 47% of the
  fleet unwatched. CLAUDE.md 10.8 records this exact defect being found and ruled
  on once already, via an `is_horse` filter; this is the same hole arriving by a
  different route
- `fn_ca_diamond_snapshot`, `fn_ca_supply_snapshot` and
  `fn_ca_weekly_revenue_digest` reported their 1,324,300 diamonds as
  certification-harness money rather than money players hold

## Why it was missed this morning

`fn_ca_is_fixture_account` had the identical defect, matched the identical 468
horses, and was corrected that morning by asking the profile whether it is a
horse. **Its twin was not.** Two predicates meaning the same thing, one fixed, one
not - which is what having two of anything costs. They are asserted to agree now.

## The fix

A horse is a player, so it is never certification equipment, whatever its address
looks like. Certification equipment is whatever `ca_cert_accounts` says it is - a
deliberate register, which correctly holds no horses. Membership of the fleet is
never again inferred from an email domain or a uuid shape.

**No balance moved.** What changed is which side of the books those diamonds are
reported on, and whether 468 players may collect what they have earned.

## And then the door itself

With eligibility fixed, the daily bonus still could not be claimed by a horse,
because its only door opens with `auth.uid()` and a horse has no browser. A rule
saying horses qualify, behind a door only a browser can open, is precisely the
shape 10.5 forbids - not a filter, an input device the horse does not have.

The engine now supplies what a browser would, exactly as it already does for the
daily-challenge claim: it names the player it is acting for, and only the engine
may. A browser that names somebody else is refused rather than ignored. Every
other rule of the bonus is untouched - the same tiles, the same
once-per-slot-per-day, the same idempotency, the same per-user caps, the same
refusal reasons.

The parameter was added by DROP and CREATE rather than a second overload, because
two bodies drift: earlier the same day I patched the wrong overload of
`record_daily_challenge_event` and 733 completed challenges went unclaimed while
the migration reported success.

## What is still to do

**This opens the door; it does not walk through it.** Deciding that a horse
collects its bonus today, and which tile, is engine behaviour and belongs beside
the rest of HorseLogic. Until that lands, the only change is that the door is no
longer bolted against players who qualify.

## Verified

Rolled-back probes on production: all 1,000 horses read as players and every one
is eligible; the 51 active certification accounts are unaffected and still read as
certification accounts; the deploy gate reports **0 unexplained** after 1,324,300
diamonds move columns in the reporting; and a horse claimed a real tile
(2,846 to 2,851) while a browser naming another player was refused.
