# Mystery Bounties: Chests Only, At The Money, 50/50, Pick 1 Of 3 (2026-10-22)

Dan, 2026-10-22:

- "DON'T PAY ANY BOUNTIES UNTIL PLAYERS ARE 'IN THE MONEY' ALL BOUNTIES ARE
  MYSTERY BOUNTY PRIZES ONLY."
- "CHANGE IT TO THE 50/50 HALF PAYOUT, HALF BOUNTY POOL."
- Agreed the same morning: each knockout is offered 3 sealed chests, picks one,
  wins it, and is then shown what the other two held. Those two are real prizes
  that stay in the pool; the next knockout's three are a fresh random draw.

## What It Did Before

Every mystery event split its bounty pool 50/50: a "regular" half that paid a
flat head on every knockout before the money, and a "mystery" half sealed into
chests at the money. The bounty was about 40% of the entry, and a field of ten
or fewer never opened chests at all.

## What It Does Now

### No Bounty Before The Money, 100% Into Chests

- `a4_mystery_mtt_terms` (trigger on `tournaments`, `fn_ca_mystery_mtt_terms`):
  every paid, pre-start mystery MTT has `mystery_bounty_pool_percent = 100`,
  `mystery_bounty_regular_pool_percent = 0`, activation `at_the_money`, and a
  description that states its split and these rules.
- `fn_claim_bounty_legacy_candidate_20260907`: a pre-activation bust of a
  chests-only event is placed with no bounty obligation
  (`bounty_blocked = mystery_bounties_start_in_the_money`), so nothing is paid
  and the head stays in the pool; no warning alert, because this is the rule.
- `fn_mystery_bounty_unrecorded_head_cents` holds nothing back for a
  chests-only event.
- Engine: `shouldActivateMysteryBounty` takes `chestsOnly`, so a chests-only
  field of ten or fewer opens its chests at the money (otherwise its knockouts
  would pay nothing). Events created under the old terms keep the old rules.

### 50/50 Entry Split, Rake From The Prize Half, Whole Chips

Dan, 11:53 CT: "YOU ALSO NEED TO ACCOUNT FOR THE RAKE, SO RAKE COMES OUT OF THE
TOP 12.5% PAYOUT, 50% GOES INTO THE BOUNTY POOL. MYSTERY BOUNTIES ARE ALWAYS
FULL CHIP AMOUNTS, NEVER FRACTIONS."

- A NEW mystery event's `bounty_amount` is half of the WHOLE entry (buy-in plus
  fee) in whole chips (whole Diamonds at the arena); the fee comes out of the
  prize-pool half. A 20 entry with a 2 fee: 10 bounty, 8 prize pool. Set by the
  trigger on insert and by `mysteryBountyTerms.ts` at spawn.
- Every chest is a whole chip: `fn_mystery_bounty_seed` accepts the serving
  engine's cent-cut inventory or the new engine's whole-chip one and seals it
  on whole chips by largest remainder (cents under one chip stay in the bounty
  pool for the champion's residual); `fn_mystery_bounty_reserve` splits a shared
  chest in whole chips; the engine and the lobby projection cut whole chips.
- The 14 events already taking registrations keep the split their entrants paid
  (40% of the entry to the bounty); their descriptions say so.

### Pick 1 Of 3

- `tournament_bounty_award_offers`: each new award gets two companion chests,
  drawn at random from the chests still available (trigger
  `zz_offer_mystery_award_companions`). They stay available, so they remain in
  the pool and later offers are independent random draws.
- `fn_mystery_bounty_pick(award, slot)`: the designated revealer's choice,
  recorded once, before the reveal.
- `fn_mystery_bounty_offer(award)`: before the reveal, only how many chests and
  the pick; after it, every chest's amount (a random slot if nobody picked).
- The award's own chest is the prize in the picked slot. The chest order was
  shuffled with a CSPRNG when the inventory was sealed, so the prize is a
  uniformly random chest whichever slot is picked, the same odds as three
  random hidden chests, and every amount shown is a real chest of the event.
  No money function changed.
- Client: `MysteryBountyChest` shows the three chests, records the pick with
  the reveal, and lists "The Other Chests Held" after the prize. Auto-open
  leaves the slot to the server. TablePage reads the offer on the pending
  broadcast, after the reveal, on the revealed broadcast and on restore.

### Lobby Copy

`fn_mystery_bounty_inventory` reports `regular_pool_percent`; the Rewards panel
says "No Bounties Are Paid Before The Money" for a chests-only event instead of
the small-field note.

## Migrations

`20261022162651` (functions and offers), `20261022162714` (triggers),
`20261022162733` (events on the board and schedules), `20261022170421` (half of
the whole entry, whole-chip chests, the offer table's grants) and
`20261022170611` (the seed reports the whole-chip pool it sealed) and `20261022173156` (states the
grants of the two re-created definer functions). Proved in
rolled-back probes on production: a 27 + 3 entry is created with a 15 bounty,
pool 100/0, at the money and the new description; a 1,000.37 pool cut at the
cent by the serving engine is sealed as 500 + 500 and reported as 1,000.00; a
whole-chip cut is sealed as given. The first combined
attempt timed out twice on `DROP TRIGGER IF EXISTS`, whose ACCESS EXCLUSIVE
lock queues behind every reader; new triggers need no drop.
