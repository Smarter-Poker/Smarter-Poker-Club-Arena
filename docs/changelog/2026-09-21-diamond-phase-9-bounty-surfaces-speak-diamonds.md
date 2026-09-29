# Diamond Phase 9: The Bounty Surfaces Speak Diamonds

Status: Phase 9 In Progress. `ca_arena_settings.tournaments_enabled` Remains
False. Client Only: No Migration Was Written, Rehearsed Or Applied.

The Phase 9 mystery changelog
([a mystery chest holds whole Diamonds](2026-09-14-diamond-phase-9-a-mystery-chest-holds-whole-diamonds.md))
left one item for the client pass before the switch opens: the reveal, chest,
celebration and ranking surfaces formatted Diamond amounts with the chip
formatter. This is that pass.

## What Was Already Done, And By Whom

The five files that changelog named - `MysteryBountyPanel.tsx`,
`MysteryBountyCelebration.tsx`, `MysteryBountyService.ts`, `RewardsTab.tsx` and
`TournamentRankingCard.tsx` - were moved onto the event's unit by #4954
(2026-09-20), together with the seat's bounty badge, the knockout float, the
session summary and the results page
([a Diamond player can find their way](2026-09-20-a-diamond-player-can-find-their-way.md),
section 3). Read again on `main` for this pass and not rebuilt.

## What Was Still Speaking Chips

A census of every surface that prints a bounty, a head, a bounty won, a prize or
a knockout payout for a tournament found six more, each of them the same
defect in one of two shapes: a figure followed by the literal word "Chips", or
a figure handed to a formatter that keeps two places for a fraction.

| Surface                                   | What a Diamond event saw                                                                                   | Unit read from                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `TournamentWinnerOverlay`                 | the prize counted up through `formatTableChips`, so it climbed through "17.45" and landed on a bare figure | `arenaAssetUnitCentsIfRead(arenaAsset)`, passed by `TableModalsLayer`                                          |
| `FinalTableOverlay`                       | "1.2K Chips" after the pool                                                                                | `tournamentRowUnitCents` in `TournamentDetails`; the table's read-or-null unit in `TableModalsLayer`           |
| `MysteryBountyChest`                      | the reveal and each split share as a bare figure                                                           | `arenaAssetUnitCentsIfRead(tableState.arenaAsset)` in `TablePage`; the selected row's unit in `TournamentPage` |
| `TournamentPage` Bounty and PKO rows      | "25 Chips" and "25 Chips Starting Bounty"                                                                  | `selectedUnitCents`, the row's own arena embed                                                                 |
| `DetailOverviewTab` podium and Bounty row | "1.2K Chips" on every podium prize, a bare head                                                            | `overviewUnitCents`, the row's own arena embed                                                                 |
| `signUpDialog`                            | "5 Chips" for the head, and a chip balance, a chip gate and the chip cashier                               | `tournamentService.readTournamentUnitCents(id)`, read by `useTournamentRegistration`                           |

The rule on every one of them: a chip event prints exactly what it printed
before, because at the chip unit each branch is the old expression or a
unit-aware formatter that IS the old formatter (`formatPrizeAtUnit(x, 1)`
returns `formatTableChips(x)`); a Diamond event prints whole Diamonds through
`formatPrizeAtUnit` and names them with `moneyWordAtUnit` or
`moneySuffixAtUnit`, the estate's own Diamond formatting. No new glyph or
format was introduced.

## An Unread Asset Prints No Figure

`arenaAssetUnitCents` answers an unread arena with `UNIT_CENTS_ASSET_NOT_READ`,
the named cent, and the seat badge and the knockout float keep that answer.
The three table surfaces that print a prize at a moment of their own - the
winner's prize, the chest and the final table's pool - now take
`arenaAssetUnitCentsIfRead`, which answers `null` until the table's arena has
been read, and each prints no figure for `null`: the prize line and the pool
line wait, and the chest reveals with its figure slot empty. The Sign Up card
shows its own unknown mark (`--`, the one its balance row has always used) for
a head whose unit could not be read.

The session summary and the ranking card keep #4954's named cent for an unread
asset, deliberately: their payloads are persisted, every payload without an
asset predates Diamond tournaments, and TablePage stamps the asset it loaded
the table with onto every new one.

## The Sign Up Card Stops Reading A Chip Wallet For A Diamond Entry

None of the six callers of `useTournamentRegistration` builds its payload
with the tournament's arena in it, so the card could not know what it was
selling. The hook now reads the unit off the tournament's own arena through
`readTournamentUnitCents` (the same `TOURNAMENT_ARENA_EMBED` `getTournament`
carries, answered through `tournamentRowUnitCents`), started beside the ticket
lookup so the card opens no later than it did.

That exposed the larger fault on the same card: `fn_player_spendable_balance`
falls back to the player's home chip club when the arena has no member row
(read from production, 2026-09-21), so a Diamond sign-up printed a chip
balance, disabled Confirm when that chip balance was below the Diamond price
and offered the chip cashier. A Diamond entry now reads no chip wallet: the
balance row is not shown, nothing is gated on it, and the Diamond door refuses
an underfunded entry itself with `insufficient_diamonds` ("Not Enough Settled
Diamonds In Your Diamond Wallet."). An unread unit reads no wallet either and
fails open to the server, exactly as R7 already does for an unreadable balance.

## The Law

`tests/the-diamond-arena-is-diamonds-only.law.test.ts` gains a census over
every tournament surface (any `src/` file whose path names a tournament, a
bounty, a mystery or a knockout, plus TablePage, TableModalsLayer, SeatSlot and
SessionSummaryHost): no bounty, prize, payout, knockout, winnings or award
figure may be followed by a literal "Chips", and none may be handed straight
to `formatTableChips`, `formatChipAward`, `formatStackChips` or `formatChips`.
It proves its detectors still see the six shapes removed here, pins the
read-or-null unit on the three table surfaces, and pins the Sign Up card's unit
read and its chip-wallet gate. Run against the code before this change it names
exactly the six offenders.

## Tests

Added: `tests/components/TournamentWinnerOverlayUnit.test.tsx`,
`tests/components/FinalTableOverlayUnit.test.tsx`,
`tests/components/MysteryBountyChestUnit.test.tsx`,
`tests/unit/detailOverviewSpeaksTheEventUnit.test.tsx`,
`tests/unit/tournamentPageHeadSpeaksTheEventUnit.test.tsx`,
`tests/unit/signUpCardSpeaksTheEntryUnit.test.tsx`. Each renders the real
surface at the chip unit (asserting the exact old text) and at the Diamond
unit, and the table surfaces and the card also with an unread unit. Run
against the previous source, every chip case of the five surface tests passes
and every Diamond and unread case fails; the card's test fails throughout,
because its chip cases also assert the new unit read.

Moved with the change, not weakened: `winnerPrizeAnimationLifecycle`,
`MysteryBountyChest.amount` and `tournamentEntryTicketRegistration` state the
chip unit their assertions were written for.

## Left As Found, And Why

- Stat tiles and lobby cards that print a bare whole figure beside a label
  (the info panel, the HUD's Spin prize, the break screen's pool, the rewards
  pool tiles, the lobby's GTD and prize labels, the lobby card): a whole Diamond
  prints the same digits through them and no chip noun is attached, which is
  how #4954 treated the same tiles.
- The stats pages' tournament totals: an asset dimension is owed by the
  database first (`chip-and-diamond-figures-never-sum`, with its runbook).
- Cash-table copy that prints a dollar mark (the Seven-Deuce announcement and
  the Cashout Locked toast in TablePage): cash surfaces, outside this pass.
- `TournamentAnnouncementOverlay`'s knockout and mystery configs print a raw
  amount, but no code sets either announcement type any more.
- A Diamond balance line on the Sign Up card would need the settled figure the
  Diamond door checks; no client read of it exists yet, so the card shows none
  rather than a guess.
