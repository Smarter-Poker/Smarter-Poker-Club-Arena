# The five launch owner decisions (2026-10-07)

Phase 5 of the Club Arena launch checklist was five questions left for the
owner. Dan handed them back: "THESE ARE ALL YOURS TO FINISH UP AND DECIDE".
Each one is decided here under CLAUDE.md 10.9, from what production actually
held on 2026-10-07, and fixed at the line that produced it.

Migrations `20261007014946_five_launch_owner_decisions` (decisions 2, 3 and 4)
and `20261007015026_a_diamond_jackpot_hit_pays_every_diamond_it_announces`
(decision 5). Law: `tests/five-launch-owner-decisions.law.test.ts`.

**Delivery status.** Decision 1 and the browser half of decision 4 need no
database change and ship first. The two migrations are on branch
`fix/owner-decisions-db`; their production install was not approved in this
session (the apply came back cancelled and nothing was written), so they wait
for that approval. Until then the database half of 2, 3, 4 and 5 is decided and
built, not live.

## 1. Hi-lo insurance: not offered

**What it did.** On PLO8 and FLO8 the insurance price covered the high half
only, and any hand with two winners was a push. The commonest hi-lo outcome,
the leader taking one half, either gave him free cover (he took the high,
someone else the low) or paid him nothing (he lost the high, kept the low). The
price on the dialog was not the contract that settled.

**Decision.** Insurance (and its EV cashout) is not sold on a split-pot game,
which is what the rooms this product copies do. It follows the 2026-10-06 rule
that an offer is made only where the contract is exact.

**Change.** `insuranceContractIsExact()` refuses a hand whose own variant is
hi-lo (so a hi-lo bomb pot on a high-only table counts), and the create-game
flow shows no Insurance switch on a hi-lo game and always sends it off. A
switch that could do nothing is not shown.

**Owed.** Nothing: the horse-brain Phase 9 record states no Omaha insurance
contract has ever been bought, and no live or dormant hi-lo game has insurance
on (read 2026-10-07: 0 of 20 hi-lo cash games).

**Proof.** `InsuranceContractIsExact.test.ts` (hi-lo refused on one pot, high
Omaha still offered) and `Phase9OmahaInsurance.test.ts`, whose PLO8/FLO8 cases
now drive a real turn all-in to three rivers (scoop, opposite scoop, split)
and prove no offer is made and an accept is refused.

## 2. Unpaid advertised rewards: a promotion carries no prize money

**What it did.** A promotion's prize pool is shown to players ("Prize 5K") and
nothing pays it: there is no high-hand scorer, no rake-race settler, no
promotion leaderboard payer, and a promotion claim credits no wallet. Four
promotions on Club JAQK advertised 9,500 between them. The 2026-08-29 guard
only filed a warning.

**Decision.** 10.9's clear path to pay does not exist: no entry or claim was
ever made (promotion_leaderboards 0 rows, promotion_claims 0 rows) and no rule
says who would be owed what. So the platform stops advertising money it cannot
pay. Paid leaderboard prizes stay with the club leaderboard programme, which
has a settler.

**Change.** Every promotion's prize pool is 0, the three still reading active or
scheduled months after their end dates are cancelled, and the CHECK
`promotions_advertise_no_unpaid_prize` refuses a prize pool until the change
that builds a payer lifts it. The warning trigger is dropped, as its own header
asked: the gap it reported can no longer happen.

**Owed.** Nothing: nobody entered or claimed.

## 3. Tournament result notices: every paid finish of a scheduled event is told

**What it did.** No tournament result notice had ever been sent
(`notifyTournamentResult` had no caller). The result card shows to a player
still at the table; a scheduled event pays at its end, hours after most of its
money finishers busted and left, and they were told nothing.

**Decision.** Every payout of an MTT or satellite writes one in-app notice to
its player: "You Finished 2nd And Won 25.26 Chips", "You Won A Seat In ...",
"Bubble Protection Paid You 180 Chips", in Diamonds on the Diamond Arena.
Horses are told on exactly the same terms (CLAUDE.md 10.5). Spins and Sit and
Gos end with their players seated, where the result card already tells them.

**Change.** `trg_tournament_payout_tells_the_player`, AFTER INSERT on
`tournament_payouts`: written in the payment's own transaction, one per player
per event (unique index), and a notice that cannot be written never blocks the
payment. No job, no sweep. Measured volume about 1,440 a day. The notice links
to the event's own page and reaches the push outbox through the existing
mirror.

**Proof.** A rolled-back production probe over real payouts wrote four notices
(an MTT win with cents, a whole-chip win, a satellite seat, a bubble refund),
skipped the Spin, and mirrored four push rows.

## 4. Club-card upload policy: only a club's owner writes its card

**What it did.** Any signed-in account could insert or overwrite any object
under `club-assets/club-cards/` (the "owner update" policy had no owner test),
so anyone could replace any club's lobby card with any picture. The home page
also tried to bake and upload a card for every club a member could see.

**Decision.** A club's card image is the club owner's to set, the same rule
the club row already has ("Owners can update clubs"). The bucket's limits stay:
PNG, JPEG, WebP or GIF, at most 2 MB.

**Change.** The two open policies are replaced by owner-only insert and update
policies through `fn_club_card_object_is_callers(name)`, which admits a
`club-cards/<club number>-card-...` object only for that club's owner. The home
page bakes a missing card only for a club the viewer owns.

## 5. Diamond payout ladder leftovers: a jackpot hit pays every Diamond it announces

**What it did.** The Diamond bad beat jackpot floored the loser's, winner's and
each table share separately and left the leftover in the pool: its own
acceptance case paid 104 of an announced 105. The chip jackpot pays the whole
announced total and gives the table remainder to the losing hand.

**Decision.** The Diamond hit pays by the chip rule: the paid total is floored
once from the pool, and every Diamond of it is paid, the leftover to the losing
hand. The door refuses to finish a hit that paid anything else. The tournament
prize ladder was checked the same way and needs nothing: across the four
scheduled Diamond events' pools and fields of 1 to 120 it pays every Diamond,
whole, with nothing left over (480 cases, read-only).

**Owed.** Nothing: no Diamond jackpot hit has ever been paid
(`poker_diamond_jackpot_ledger` empty on 2026-10-07).

**Proof.** The isolated PostgreSQL 17 acceptance case now pays 53 / 26 / 13 / 13
of 105, leaves 45 in main, and every downstream figure follows.

## Outside these five, recorded not fixed

The scheduled "Diamond Daily Deep Stack 500" (b21e8809, 20:00 UTC on
2026-10-06) is still REGISTERING with one entrant, past its start and its late
registration, below its four-player minimum. That is the tournament start path
(`docs/runbooks/tournament-never-started.md`), owned by the Diamond schedule
work in flight, not one of these decisions.
