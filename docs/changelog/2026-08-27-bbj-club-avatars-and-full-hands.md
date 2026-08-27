# 2026-08-27 — The Bad Beat Jackpot winners page tells the whole truth

Dan, looking at the BBJ popup:

> for the BBJ seed you need to use there club avatar as the image, not there
> profile pics. and you need to fill in all the hand details and payouts, like
> all the data that we see and use inside of previous hands.

Three faults, and the second and third were hiding behind the first.

## 1. The winner rows showed social media photos

`fn_bbj_recent_hits` resolved the image as
`COALESCE(clubs.avatar_url, profiles.avatar_url)`. Both clubs that have ever hit
the jackpot carry a NULL `clubs.avatar_url`, so every row on the page fell
through to `profiles.avatar_url` — the **social media photo**, the exact column
`tests/unit/arenaAvatarSeparation.test.ts` exists to keep this app out of.

That test scans `.from('profiles')` calls in `src/` and `server/src/`. This read
lives in SQL, where the scanner cannot see it, which is the whole reason it
survived. The club avatar is `profiles.arena_avatar_url` — library art, the same
column the felt itself reads in
`server/src/services/supabase/tables.ts`. `fn_bbj_recent_hits` and
`fn_bbj_hand_detail` now read it, with no fallback to the photo.

All five seeded winners already had one, so the page changed the moment the
migration applied:

| Winner              | Now shows                                  |
| ------------------- | ------------------------------------------ |
| Valentina Salvatore | `/avatars/table/vip_spartan@2x.webp`       |
| Josephine Whitmore  | `/avatars/table/vip_tiger_boss@2x.webp`    |
| Freeway             | `/avatars/table/free_cowboy@2x.webp`       |
| broadwayKing        | `/avatars/table/vip_phantom@2x.webp`       |
| CRUX                | `/avatars/table/vip_mad_scientist@2x.webp` |

Client-side, `BBJRecentHits` now runs that value through `getAvatarWithFallback`
exactly as `SeatSlot` does, so the Hub-relative path resolves absolutely (it
worked in production by accident, because the app is served from the same
origin as the art, and would have broken in local dev), and a winner with no
arena avatar draws the deterministic monogram rather than a broken image.

## 2. The hands were not hands

Each seeded hand held **two players, two actions, both on the river**, and a
`button_seat` that was not one of the occupied seats. Every consequence of that
is visible in the screenshot Dan sent:

- `derivePositions` returns an empty map when the button is not at the table, so
  `smallBlindSeat`/`bigBlindSeat` came back null, no blind posts were
  synthesised, and no position badge drew;
- only a `River` street existed, so PreFlop, Flop and Turn were absent;
- the reconstructed pot came to 1,030 against a stored `pot_size` of 11,262.74,
  so `potReconciles` was false and `BBJHandDetail` **withdrew the running-pot
  column entirely** — which is the documented, correct behaviour: a number
  quietly off by a blind is worse than no number;
- `rake_amount` and `bbj_amount` were both 0, so the "Taken From The Pot" line
  never drew.

And the cards did not make the stated hands. CRUX was billed with _Four of a
Kind_ holding `As Ad` on a board with one ace — trip aces. `bestFive()` would
have drawn what it could actually prove, contradicting the winners list one row
above it.

All five are rebuilt whole: the full seat roster (4/6/6/5/4, matching each
payout's own `table_player_count`), a button that is at the table, PreFlop
through River, amounts that sum **to the penny** to `pot_size`, rake and jackpot
drop, and hole cards that make the category the list claims under that variant's
own rules — Omaha using exactly two from hand and three from the board.

| Hand    | Bad beat                                      | Beaten by                               | Pot      |
| ------- | --------------------------------------------- | --------------------------------------- | -------- |
| 1506711 | Valentina Salvatore, quad aces                | WASP, royal flush                       | 7,835.00 |
| 1269428 | Josephine Whitmore, queen-high straight flush | earlyPosition, royal flush              | 581.00   |
| 1253455 | Freeway, eight-high straight flush            | Caroline Myers, ten-high straight flush | 736.50   |
| 1127041 | broadwayKing, quad queens                     | Alice Bourgeois, quad kings             | 105.50   |
| 1080832 | CRUX, quad aces                               | Christopher Lee, royal flush            | 2,227.00 |

`scripts/dev/gen-bbj-seed.mjs` generates the migration. It carries a port of the
client's own `handEvaluator` and `pokerPositions` and **refuses to emit SQL**
unless every hand evaluates to its stated category, the winning hand actually
beats the bad beat, no card appears twice, the button is occupied, and blinds
plus every action amount equal `pot_size`. The migration then re-asserts the
same things in a `DO $$` block, so it aborts rather than leave a money surface
showing numbers that do not add up.

## 3. A quarter of every jackpot was never paid to anyone

`bbj_payouts` carries `winner_share`, `loser_share` **and** `table_share`, but
only the first two ever got `bbj_payout_recipients` rows. So the popup headlined
_Jackpot Paid 7,883.92_ above two lines totalling 5,912.94, and 1,970.98 was
listed nowhere. `tests/bbj-recent-hits.test.tsx` had asserted the 50/25/25 split
against a fixture the whole time; nothing checked the fixture against the table.

The table share is now split across the players dealt into the hand who were not
in it — which is what "At The Table" means. Every payout's recipients now sum
exactly to its `total_amount`, and there is one recipient per seat.

## Not touched

No chips moved. `bbj_payout_recipients` is the display ledger for a hit that was
itself seeded; nothing here writes `club_members.chip_balance`, so CLAUDE.md
§11.5 is not in play.

`isOmahaVariant()` does not recognise `bigo`, so a Big O hand would be evaluated
under hold'em rules. Production `hand_history` holds no `bigo` rows today (the
one seeded hand that claimed it is now `plo5`, matching its table), so this is
recorded rather than fixed here.
