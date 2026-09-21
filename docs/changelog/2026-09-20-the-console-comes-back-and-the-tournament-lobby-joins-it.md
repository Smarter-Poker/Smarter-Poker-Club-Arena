# The console comes back, and the tournament lobby joins it (2026-09-20)

## What happened to the sweep

`#4711` (Restore September 13 GitHub/Hetzner delivery and application
baseline, 2026-09-16) restored a September 13 tree. It took every surface the
#ClubArenaConsole sweep had rebuilt with it: 147 files across waves 1 to 6
(`#4648`, `#4566`, `#4661`), plus the felt cashier (`#4604`) and the wait list
(`#4573`) from other agents. `SpadeConsole` had 187 importers on the branch's
merge base and 40 on `main`. The live tournament card Dan saw on 2026-09-20 was
the pre-console navy sheet with the four boxes he had already ruled against.

## How it was re-landed

Not by cherry-pick, and not by taking a side. Every one of the lost files was
merged three ways with **the restore commit as the base**: ours = the console
render, theirs = current `main`. That puts every post-restore change on `main`
(the Diamond unit on every prize, the fixed-format entry contract, the cashout
receipt checks and prepared operations, the weekly accounting settlement tab,
the seat copy keyed by asset, the Diamond arena count) on top of the console
render instead of replacing it. Where the three-way could not decide, the
resolution was always the same: `main` wins on logic, the console wins on
presentation, and the two are re-married by hand. Recorded as SKILL.md trap
7.13.

Three files stay on `main`'s version deliberately:

- `ClubAdvertisePage` - its console version depends on the sponsor pricing and
  country targeting `#4711` also dropped (`AdCampaignService`), which belong to
  the ads owner; it goes back on the list until that re-lands.
- `DiamondCrashPage`, `DiamondPlinkoPage`, `BonusSetup` - eight post-restore
  Diamond commits; the Diamond owner's live workstream.
- `ThemeSettingsModal` and the studio baselines - `#4805` had already re-landed
  the console studio with fresh Linux screenshots.

## The tournament lobby

Dan, 2026-09-20: "don't forget that all the tournament cards and lobby needs
this same improvement."

**The card** (`TournamentLobbyCard`) is back on the spade master and now
carries `main`'s recorded-format contract: the eyebrow is the recorded format
or plainly "Tournament", the speed word comes from `describeStoredMttStructure`
(the same facts the details page prints) and never from a parsed blind array,
the Levels row prints the clock, entries print against the recorded capacity,
and a finished or cancelled event paints no plates at all (two actions or
none). Three defects fixed on the way: `guaranteedPrize && ...` printed a
literal `0` after every pool with no guarantee ("400" for a 40-chip pool, live
on `main` today); "1 Spots Remaining"; and a closed late-reg row printing on a
completed event. The plate reads "Unregister" - "Registered - Unregister?" did
not fit the plate at 393px.

**The lobby** (`/tournaments`, `TournamentLobbyPage`) keeps its pinned
`CasinoSurfaceHeader` (cinematicRouteFamilies) and loses everything generic
under it: the quick-stats strip that repeated the header's three counts, the
rounded search box, two rows of filled filter pills, and the purple time-window
bars with count bubbles. In their place, one spade console, "Find Your Game":
the search field as the one drawn control (two engraved rules, no box), both
filter rows as lit words (the chosen one white), and each time window as an
engraved rule with its name and count printed in the master's inks. The empty
state is a console too, with Create Tournament as a lit word. The page sits on
black; the Play Circuit skin's gradient and rounded inputs are refused at a
higher specificity because they are `!important` on the route family.

Before/after at 393px: `shots/sheet-tournament-lobby.png`,
`shots/sheet-tournament-card.png` (the left column is `main` as it serves
today).

## Tests

Every pin that named the generic surfaces moves with the re-render, same
commit: Title Case fixture messages on the Financial Alerts export test (the
console prints every message through `titleCase()`), `Mark Resolved` by name
(the Resolve All plate is always painted), `Position #N` on the XMTT card,
`52.5K` in the MTT overview (`compactChips` never rounds a figure up), `Hand
For Hand`, `Decline Rebuy`, the late-reg countdown rather than the split label.
Two of those files are pinned by `tests/fixtures/full-weekly-accounting/
source-binding.json`; both are restamped with the reason in the binding's own
audit block (`console_reland_rebinding_20260920`).

The horse package (`#4697`, "a horse is never named") shares this branch's
merge base and is folded in the same way rather than re-merged on its own.

## Inventory after this lands

`find-generic-surfaces.mjs`: 218 spoken for, 11 to go - 8 with no importers
(dead code), `ClubAdvertisePage` (waits for the ads re-land),
`PokerArenaLandingPage`, and nothing else.
