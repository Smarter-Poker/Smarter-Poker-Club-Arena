# 2026-09-05 - The avatars, the broken square, and what crest*cert*\* is

Four things Dan reported looking at his own Friends page.

## The avatars were being cropped, not framed

`.friend-avatar img` was `object-fit: cover` in a 48x48 circle. The avatar
library is **table-seat bust art**: measured,
`/avatars/table/free_viking@2x.webp` is **250 x 340** - a portrait. `cover` in a
square box scales it to 48 x 65 and throws 26% of its height away from both
ends, and the circle then clips **31%** of the opaque art. Centred, what it
removes is the top of the head: the viking lost his horns, the wizard his hat,
the space commander the top of his head.

Rendered all five candidates against six real avatars before choosing: cover
centred (shipped), cover top, cover 18%, contain-inside-the-circle, and no
circle at all. Anchoring to the top is the only one that keeps the whole head
AND fills the circle; `contain` leaves a small portrait floating in a ring, and
dropping the circle loses the online dot's anchor and the row rhythm.

`object-position: 50% 0%` on the six circular avatar rules across the Friends
surface. It is a **no-op for square or landscape sources** - there is no
vertical overflow to position - so it cannot disturb an avatar that was already
correct. `SeatSlot.css` is deliberately left alone: its `50% 100%` anchors the
bust to the bottom of a seat, which is right there and wrong here.

## The broken square next to COMMUNITY

Dan: "the broken square next to community". Both section rails drew their
status light as a **6-7px box with `border-radius: 1px` and a 1px near-white
border**. At that size the border is a third of the width, so it renders as a
hard-edged little square beside a word - it reads as a broken glyph, not an
indicator. It is a round light now: radial gradient, brightest at the centre,
no hard ring, the glow doing the work. Fixed in both rails, because both had it.

## crest_cert_854825cjxkf0 is a certification fixture

Every run of `club-create-certification.yml` signs up a throwaway account
(`club-create-cert-<ms>-<rand>@smarter-poker.invalid`, username
`crest_cert_<stamp>`), has it create a club, proves the flow works, and cleans
up. Two things then happen, both working as designed:

1. `trg_auto_connect_dan` friends **every** new profile to the founder, in both
   directions, accepted. That is the deliberate feature behind his friend count,
   and it fires for the fixture exactly as for a real signup.
2. The harness's account delete then fails - correctly. Probed on production:
   `chip_ledger_performed_by_fkey` refuses it, because the fixture wrote ledger
   rows when it created its club. **A money ledger must keep who performed each
   row.** Deleting the actor is not an option and must not become one; the
   script only `console.warn`s, so the failure was invisible.

So the account cannot go and the friendship cannot be justified. The fix is not
to give it one: `auto_connect_to_dan_bekavac` now skips `@smarter-poker.invalid`,
a domain reserved by RFC 2606 that can never be deliverable, and the 18 rows
already collected are removed. 1,309 friends -> 1,300.

**HORSES ARE PLAYERS (10.5).** The predicate was checked against production
before it was used: 9 accounts match, **zero** are horses. Horses live under
`horses.smarter.poker`, `hydra.smarter.poker`, `horse.ai` and
`bot.smarter.poker`; all 22,820 horse friendships are untouched, and the
migration refuses to apply if a horse ever carries a `.invalid` address.

## The union directory

Verified rather than assumed, against what is actually deployed on `main`:
every file that names `/unions` - the route in `App.tsx`, both navigation
configs, and the Community Center card - carries the `canOperateUnionNetwork`
gate, and `fn_can_i_operate_the_union_network()` returns **false** for a real
non-allowlisted account and **true** only for the founder. Nothing changed here;
it was already right.

## Still open

The same portrait-in-a-circle crop exists on about a dozen other surfaces
(`GamificationLeaderboard`, `LeaderboardPodium`, `TournamentRankingCard`,
`PlayerCard`, `EliminationOverlay` and others). They are a mechanical sweep of
the same one-line fix, but each wants a look before it ships, so they are named
here rather than changed blind.
