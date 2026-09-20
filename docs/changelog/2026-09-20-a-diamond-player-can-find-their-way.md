# A Diamond Player Can Find Their Way

Status: Phase 7 In Progress. `ca_arena_settings.cash_games_enabled` And
`tournaments_enabled` Both Remain False. No Production Migration Was Written Or
Applied By This Work.

Three things a Diamond player could not do, and can now: leave the lobby, read
their own hand history as the arena's record, and see a bounty or a mystery
chest priced in the unit it will be paid in.

## 1. The Arena Had One Room And No Doors

Phase 7 pointed the Diamond route at the shared Club Arena lobby and left every
other route under `/clubs/diamond-arena/` on the safe shell. That was right for
the operator doors and it is the rule this work preserves: "no unions or agents"
has to hold on a typed URL, not only on a hidden link, so finance, agents,
operations, control, the cashier, settlement, the wheel, the diamond games,
settings, hand review and every other chip operator screen still render
"Welcome To Diamond Arena" under the arena key.

It was wrong for the player doors. Tournaments, the roster, a member's own
profile and statistics, and the messenger all rendered the shell instead of
their page, and `clubFooterVisibility` keeps the chip footer off the arena (its
six cells are chip club doors and its artwork names them), so nothing stood in
its place. A Diamond player reached the lobby and stopped there.

What changed:

- `src/components/arena/diamondArenaRoutes.ts` is the allowlist, stated by name:
  the lobby, tournaments, messages, and members with its `:userId` and
  `:userId/statistics` children. Everything else under the arena is an operator
  route by construction, so a route added to the app next month is closed to the
  arena until somebody writes it here on purpose.
- `ArenaAccessBoundary` renders its children on a player route and keeps the
  shell on the rest. The closed-games notice now belongs to the lobby only: it
  read correctly above a game board and said nothing useful above a roster.
- `src/components/arena/DiamondBottomNav.tsx` is the bar that stands where the
  chip footer does not, carrying exactly the six player surfaces: Lobby, Hand
  History, Stats, Players, Messages, Wallet. The Wallet opens the existing
  `DiamondWalletModal` in place and never navigates, exactly as
  `DiamondArenaWallet` opens it over the lobby.
- `shouldShowDiamondFooterFor` is the other half of the chip footer's answer. It
  takes the same two inputs `shouldShowClubFooterFor` takes, for the same reason:
  the in-table "+" opens a club lobby as a TAB while the URL stays on
  `/table/<id>`, so a route gate alone would put the wrong chrome around the
  Diamond lobby. It also follows the two global doors while they are scoped to
  the arena (`/hand-history?arena=diamond`, `/stats?club=diamond-arena`);
  clearing the scope returns the page and its footer to the estate.

### One Bottom Edge, One Bar, And Where That Is Actually Decided

Under the arena the two rules cannot both be true: every path the Diamond bar
claims there is a path the chip rules already refuse, so "exclusive by
construction" is accurate for the lobby, the roster, the tournaments, the
messenger and the arena lobby opened as a tab.

It is NOT accurate for the last case, and the first draft of this work said it
was. `/hand-history` and `/stats` are ESTATE pages that `shouldShowClubFooter`
has always returned true for, and it takes a pathname only - it never sees a
query string, so it cannot change its mind because the page is scoped to the
arena. On exactly those two paths both rules are true, and the first draft would
have stacked two fixed bars on one bottom edge while a comment beside them said
that could not happen.

So the decision is stated where it is made. `App.tsx` reads
`diamondFooterVisible` once and the chip footer is rendered behind
`!diamondFooterVisible &&`: the Diamond bar owns the edge wherever it stands,
and the chip bar comes back the moment the scope is cleared.
`tests/the-lobby-always-has-its-footer.law.test.ts` pins that guard with a
failure message naming the two paths, and `tests/unit/clubFooterRouteAudit.test.ts`
asserts the overlap as a LIST rather than as a claim - if the chip rule ever
starts refusing those two paths on its own, that list goes empty and the test
says so, because a guard nobody needs should be deleted rather than left behind
reading as the reason.

### The Frame Is The Master's, With Its Painted Doors Removed

No new artwork was invented. The chip master paints six chip doors and their
words into the leather, so the frame here is derived from that master by surgery
(the `#ClubArenaConsole` standard, section 5): the quilted well is tiled from a
clean stretch between two painted icons, row for row so the vertical vignette
survives exactly, brightness matched to the master's own horizontal profile so
the well stays one tone, and the chrome rim, corners and gutter are the master's
own bytes. `scripts/art/derive-diamond-footer.py` is the derivation and it is
re-runnable from the master.

The six labels are live DOM text printed into six equal cells, fitted with
`useFitText` so no word can touch the rim, in the master's own silver plus a
bevel, with the current page's word lit in the master's blue. Nothing is drawn:
no fill, no border, no gradient, no glyph stuck on top. The chassis itself is
the chip footer's own stylesheet, imported rather than copied, so the fixed
placement, the aspect ratio, the overscan, the hide-on-scroll behaviour and the
published bottom-chrome height are one implementation and not two. The light
scheme (`data-arena-scheme`) is untouched: the footer is artwork, like the club
card panels and the global header, and it keeps its own treatment.

## 2. Hand History Was Every Club At Once

`HandHistoryService.getPlayerHands` had no club or asset filter. Rows are
labelled per asset (`tables -> arena:clubs!fk_tables_club_id(asset)`) and
`HandHistoryPage` computes per-asset totals off those labels, but the query
itself returned the cross-club archive, so the Diamond footer's Hand History
door could only ever open a Diamond player's record with every chip hand they
have ever played mixed into it.

The scope is now the SERVER's, which is the part that matters. `hand_history`
has no club column and no foreign key to `tables` (verified against production
2026-09-20: its only inbound keys are `ca_hand_facts`, `ca_hand_flags` and
`ca_hand_notes`, and it has none outbound), so the join that labels a row cannot
filter the query that produces it. `ca_hand_facts` can: one row per player per
hand, written at settlement with the table's `club_id`, under
`ca_hand_facts_hand_id_fkey` and an RLS policy of `user_id = auth.uid()`.
Embedded `!inner` and filtered on its `club_id` it selects exactly the hands
THIS player played in THAT club, so the page, the order and Load More all remain
the database's.

A client-side filter would have been wrong in a way that stays invisible until
it matters: page one of fifty cross-club hands can hold no Diamond hands at all,
and "no hands" would have been indistinguishable from "none on this page".

The option is `clubId` or `asset`. `asset: 'diamonds'` resolves to the arena
club because there is exactly one club on this platform with that asset and it
is the platform arena, checked against production on 2026-09-20. Only
`'diamonds'` is expressible and the TYPE says so rather than accepting `'chips'`
and ignoring it: `hand_history` has no reachable asset column and there are
hundreds of chip clubs, so "every chip hand" is not one club id and cannot be
expressed as one. An answer that cannot be given is better made unrepresentable
than given a well-formed shape.

The page carries a `Diamond Arena` filter chip in Title Case beside its
existing ones. Unlike its neighbours it moves the ROUTE rather than a filter
state, because the scope is a server scope and the record has to be refetched
for it. Releasing it returns the cross-club record.

## 3. A Diamond Bounty, Chest And Prize Now Read In Diamonds

#4938 and #4685 gave the tournament PRIZE surfaces a unit: the lobby's projected
ladder, the sign-up dialog, the detail overview, the info panel and the rewards
ladder all price a place through `placePrize` with `tournamentRowUnitCents`. The
BOUNTY and MYSTERY surfaces were not in that pass, and every one of them still
printed the chip contract:

- a seat's bounty badge printed two decimal places for any head carrying cents,
  which at a Diamond table is a fraction of a Diamond the bounty bank cannot pay;
- the knockout float beside it used `formatChipAward`, the same contract, with
  the same result;
- every mystery chest figure went through `MysteryBountyService.formatCents`,
  which had no unit at all, so a Diamond chest advertised cents it cannot hold;
- the ranking card, the session summary, the results table, the rewards tab and
  the reveal announcement each printed a prize or a bounty through their own
  local chip formatter, and several of them printed a bare figure with no noun,
  so a Diamond amount did not even say what it was.

NOTHING WAS EVER SHOWN WRONG TO A PLAYER, and this says so rather than implying
otherwise: zero Diamond tournaments have ever existed and
`tournaments_enabled` is false. This is the gap closing before the switch, not
damage being repaired after it.

### One Rule, Three Domains

`formatPrizeAtUnit` takes an amount. The bounty and mystery surfaces do not all
speak that domain, so `src/utils/format.ts` gains the same rule expressed where
each of them lives:

- `formatPrizeCentsAtUnit(cents, unitCents)` for the chest ladder, which is
  integer cents off `fn_mystery_bounty_*`. At the chip unit its body is the old
  `formatCents` character for character.
- `formatAwardAtUnit(amount, unitCents)` for the "+N" that floats up from a
  seat. At the chip unit it RETURNS `formatChipAward`, so the exact-to-the-cent
  contract the 2026-09-04 knockout audit established is unchanged, one call
  deeper.
- `moneyWordAtUnit`, `moneyAdjectiveAtUnit` and `moneySuffixAtUnit` for the word.
  `moneySuffixAtUnit` adds the noun for a Diamond event and adds NOTHING for a
  chip one, which is deliberate: the requirement is that a Diamond figure names
  its unit, not that every figure in the estate grows a noun. A chip surface
  that printed "Won 500" still prints "Won 500".

`MysteryBountyService.formatCents` now takes a REQUIRED, undefaulted unit and
its body is `formatPrizeCentsAtUnit`, so there is one rule and not two. The
requirement is the point:
`tests/a-tournament-prize-knows-its-unit.law.test.ts` exists because four money
rules defaulted their unit to a cent and every caller omitted it, which made the
unit work look finished from every call site while it was wired to nothing.

`arenaAssetUnitCents` (`src/lib/arenaUnitCents.ts`) is the same unit for the
surfaces that hold no club row. The felt holds an `ArenaIdentity`, and the only
way to get one is `parseArenaIdentity`, which returns `'diamonds'` ONLY for a
row satisfying `asset = 'diamonds' AND is_platform IS TRUE AND union_id IS NULL`
and throws on anything else. Those are the three conditions
`fn_ca_tournament_unit_cents` tests, so the asset on a table state already
carries their answer and this reads it rather than deriving it a second time. An
unread arena answers `UNIT_CENTS_ASSET_NOT_READ`, which is greppable, rather
than a quiet cent.

It is an ADAPTER and not a second copy of the rule, which matters because it
sits in `src/` rather than beside `tournamentUnitCents`: every value it returns
is imported from `server/src/tournament/tournamentUnit.ts`, and
`aDiamondEventIsPricedInDiamonds` pins that it names none of the three club
columns itself. It lives on the client for the same reason `placePrize` does -
its input is a browser-only one - and it keeps this delivery out of the engine
release lane, which no client change should enter.

### Where The Unit Comes From, Surface By Surface

| Surface                                             | Unit read from                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `SeatSlot` bounty badge                             | `bountyUnitCents`, passed by `TablePage`                                           |
| `TablePage` knockout float                          | `arenaAssetUnitCents(tableState.arenaAsset)`                                       |
| `TournamentRankingCard`                             | `unitCents`, from `TournamentRankingHost` off the session payload's arena asset    |
| `SessionSummaryHost`                                | `arenaAssetUnitCents(payload.arenaAsset)`                                          |
| `TournamentResultsPage`                             | `tournamentRowUnitCents(selectedTournament)`, the row now carrying the arena embed |
| `MysteryBountyPanel`                                | `unitCents` prop, from `RewardsTab` and `TournamentPage`                           |
| `MysteryBountyCelebration`                          | the same tournament row the mystery flag comes from                                |
| `RewardsTab`, `DetailOverviewTab`, `TournamentPage` | `tournamentRowUnitCents(tournament)`, read once per surface                        |

`SeatKnockout.tsx` needed no change and that is a measured fact rather than an
omission: it announces `<name> Knocked Out` and stamps the seat, and the award
that ships with it is TablePage's float. A test asserts it prints no figure
through any formatter, so if it ever starts carrying money it joins the list.

`TOURNAMENT_ARENA_EMBED` is exported from `TournamentService` instead of being
spelled again, because a second spelling is a second chance to omit it and an
omitted embed answers "chips" with no error anywhere.

A chip event is byte-identical throughout, by construction rather than by
inspection: every unit-aware formatter and every local wrapper returns the
surface's existing chip function at the chip unit, and each one normalises its
unit first so an absent or nonsense value takes the chip path and never the
Diamond one.

## How This Was Verified

- `npx tsc --noEmit` clean.
- The three copy gates plus `check-nav-title-case` all OK.
- Focused vitest over every file touched, the whole of `tests/components/`,
  every Diamond test, and `tests/law-registry.law.test.ts`.
- The pre-push hook's own two sweeps on the exact pushed candidate: 237 contract
  test files (4,482 tests) that read a changed file, and 126 test files (2,006
  tests) that import changed source. Both green.
- The full root suite: 1,661 of 1,663 files green. The two that are not are this
  machine, not this branch, and both were re-run on their own to say so.
  `legacyEngineCheckpointTransport` spawns Node against the native inspector and
  its own header pins the supported versions at 20 and 22; this Mac runs 26, and
  the test reads nothing either commit touches.
  `the-arena-sitemap-lists-what-it-prerenders` timed out at its 5s budget while
  1,663 files ran in parallel and passes on its own, because it shells out to
  `git log` for every prerendered route.
- The painted surface was rendered headless at 393px with the real stylesheets
  and the real artwork: all six labels centred in the well (115 of 230 frame
  rows, the well's own centre), the widest of them 11px clear of the painted
  rim, and not one needing the fit hook even with the webfont absent, which is
  the wide case. The derived frame was compared with the master numerically:
  byte-identical alpha, every change confined to the well interior (rows 29-230,
  columns 95-1824 of a 1916x256 canvas), and a largest column-to-column
  brightness step across the well of 1.5 against the master's 45.3.
- Production was read, never written: the foreign keys on `hand_history` and
  `ca_hand_facts`, the primary key `(hand_id, user_id)` and the single RLS policy
  `ca_hand_facts_own_read` on `ca_hand_facts`, fact coverage over the 300 most
  recent hands (300 of 300 carry a fact row), and the single row in `clubs` with
  `asset = 'diamonds'` (`002c2d27-...`, `is_platform` true, `union_id` null).

### Two Things This Branch Had To Answer Rather Than Route Around

**Two hand-history source pins.** `tests/unit/handHistoryPositions.test.ts` and
`tests/previous-hand-shows-this-tables-hands.law.test.ts` each required every
`hand_history` select argument to BE `HAND_HISTORY_COLUMNS`. That said two things
at once: the column list is shared, and a read may not embed anything. The first
is the invariant those pins exist for, and it is untouched here. The second was
never the point, and the arena scope appends its embed to the constant rather
than replacing it. Both now require every `hand_history` read to NAME the
constant and refuse a read that spells a column list of its own, which is the
drift they were written about. Moved in the same commit as the change, never
weakened.

**The entry chunk.** Four leaves reach first paint through modules that mount at
the app root: `diamondArenaRoutes` (App.tsx picks the bottom bar on every
render), and `format.ts`, `arenaUnitCents` and `tournamentUnit`
(`SessionSummaryHost` and `TournamentRankingHost` print a payout the moment a
session ends and now print it at the session's unit). The branch carries its own
fragment under `scripts/ci/entry-chunk.d/` saying why each one belongs there,
with the measurement beside it: the entry chunk holds 215 src modules at 154kB
gz with all four in it, against a recorded baseline of 218 at 161kB.

## Tests

Extended: `tests/unit/clubFooterRouteAudit.test.ts`,
`tests/components/club-operations-surfaces.test.tsx`,
`tests/unit/diamondArenaIsOneOpenClub.test.tsx`,
`tests/in-tab-arena-footer.test.tsx`,
`tests/the-lobby-always-has-its-footer.law.test.ts`,
`tests/unit/diamondHandHistoryAsset.test.ts`,
`tests/unit/theClientHasOneTournamentMoneyRule.test.ts`,
`tests/unit/aDiamondEventIsPricedInDiamonds.test.ts`,
`tests/components/TournamentRankingCardMysteryBounty.test.tsx`,
`tests/unit/knockoutBountyIsSharedAndExact.test.ts`,
`tests/unit/handHistoryPositions.test.ts`,
`tests/previous-hand-shows-this-tables-hands.law.test.ts`.

Added: `tests/components/DiamondBottomNav.test.tsx`.

The route audit derives the operator side by reading every `clubs/:clubId` route
out of `App.tsx`, so a route added tomorrow is classified today and no list has
to be kept in step by hand. The money pin names, for each surface, the unitless
expression that must not come back and the replacement to use instead, so a red
pin tells the next agent what to do rather than only that something moved.

Two pins were MOVED rather than weakened, and both in the same commit as the
change: `knockoutBountyIsSharedAndExact` follows the float label to
`formatAwardAtUnit` and additionally checks the unit is read from the table's own
arena, and `TournamentRankingCardMysteryBounty` states the chip unit explicitly
at every existing assertion and gains the Diamond half of the same card beside
them.
