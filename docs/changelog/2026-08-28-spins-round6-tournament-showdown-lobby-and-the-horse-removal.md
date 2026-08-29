# 2026-08-28 — Spins round 6: tournament showdowns, a lobby that cannot lie, and the horse removal

Dan's list, in his order.

## 1. The client horse loader is gone (cash included)

~150 lines in TablePage predating the server-authoritative migration. It ran on
every table once the blinds resolved and did three things, all now wrong:

- **Invented stacks.** A horse whose real stack was 0 was painted with
  `bigBlind * 100` — 2,000 chips on a 10/20 game. On a pre-start Spin that one
  fabricated frame was read as "the game has started" and locked the entire
  seat-first UI. #1618 fenced it out of tournaments; this deletes the source.
- **Wrote seats from the browser.** Finding no horses it called
  `HydraService.seedTable`, which INSERTs `table_seats` rows and DELETEs
  departed ones — unpaid seats indistinguishable from bought ones, and a seat
  delete of exactly the shape the chips-cannot-leave-the-felt ledger watch
  exists to notice.
- **Fed a map nobody read.** `horseMapRef` was written here and read in zero
  places; its TURN_CHANGE consumer left with the client HandController.

`HydraService.seedTable` now refuses on **every** table and reports, rather than
being deleted, so a caller that regrows (HorseOrchestrator still calls it) fails
loudly instead of quietly resurrecting browser seat writes. Read-only helpers
are untouched.

Checked before removing: the server fleet owns cash tables too — 201 horses
across 44 live cash tables at the time of this change, none seated by a browser.

## 2. The spin reveal beats were already wired — the earlier report was wrong

I previously reported `spin_chips` / `spin_button` as emitted with no client
handler. That was a bad grep on my part: TablePage uppercases the raw event
name before the switch, so `spin_chips` → `SPIN_CHIPS`, and both handlers exist
and do real work (the staged stack credit with its delta animation, and the
dealer button). No change was needed and none was invented.

## 3. `SPIN_FREQ_DENOMINATOR` is derived, not typed

The literal said `10_000_000`; the ladder sums to `10,000,099` — the file's own
500x-retirement note says "total freq 10,000,099 (unchanged)" a few lines below
the wrong constant. It is now `SPIN_TIERS.reduce(...)`, so retuning a tier moves
the denominator with it and the two cannot disagree. The spec test asserted
`< 200` slack; it asserts exact equality now, because a tolerance that hides a
real mismatch is how this survived. Both mirrored copies patched identically.

## 4. "Every single one disappears from the spins lobby"

Investigated hard, and the honest answer has two parts.

**What I could not reproduce:** on the current build the board is healthy. 42
REGISTERING spins in the DB, 43 rows rendered, stable across a minute of
watching; `current_players` matches real seat counts exactly; and
`fn_take_seat_and_buy_in` probed as Dan's own account inside a rolled-back
transaction returns `{ok: true, cost: 20, seat_reserved: true}` — sitting works
at the database level, and no chips were spent finding that out (rule 11.5).

**What I did reproduce, earlier in this same session:** the SPINS tab rendering
_"Nothing Matches Your Filters — 46 Games Are Open In This Club, But The Filters
On This Tab Hide Them All"_ over a board with forty-odd joinable spins on it.
The filters are real, and `saveFilters` persists them **per club per tab** —
Dan's `ca_advanced_filters_<club>` carries a SPIN entry with buy-in bands and
status chips right now. Once a combination that matches nothing is saved, every
later visit to that tab opens empty. Nothing about it says "filter"; it looks
exactly like the spins are gone, permanently.

The empty state does offer "Show All Games", and that stays — but a remedy the
player has to notice is not a fix for a lobby that lies about being empty. A
filter set that hides EVERY game is not a preference, it is a dead end, so it is
now dropped automatically and announced ("Filters Cleared, They Were Hiding
Every Game"). Deliberately narrow: only when the tab's own filters are what
emptied it, only while the club genuinely has games, and once per tab per club
so it never fights a player narrowing on purpose in the filter sheet.

The other likely contributor is already shipped: until round 5 an hour ago,
nothing listened for the service worker's `SHELL_UPDATED`, so a session could
run a days-old bundle while production served the fix.

## 5. No hover effects in the lobby

Dan: "REMOVE ANY HOVER EFFECT FROM THE SPINS LOBBY." All of them are gone from
`LobbyTable.css` — the row wash and inset rail, the desktop variant that also
lifted the row a pixel (so the board twitched line by line under a trackpad),
the `.is-mine` hover, the sortable-header hover and the favourite-star hover.
Selection and the "yours" rail remain: both are real state rather than where a
pointer happens to rest, and on a touch device a hover state is either dead
weight or actively wrong, because the browser leaves the row hovered after a tap.

Pinned by a test that fails on any `:hover` selector in that stylesheet.

## 6. A tournament showdown is always face up

Dan: "IN SPINS, ITS A TOURNAMENT, SO THE 'SHOW CARDS' POP UP SHOULD NEVER EVER
APPEAR, ALL CARDS ARE ALWAYS SHOWN AT SHOWDOWN."

Two halves, in two processes:

- **The popup.** `ASK_TO_SHOW_ON_UNCONTESTED_WIN` is already `false`, so this
  prompt is dark everywhere today — which means what Dan saw was a stale bundle.
  But that constant exists precisely so somebody can re-enable it for CASH in
  one line, and the next person to do that would silently re-arm it for every
  Spin and MTT. The rule is written into the condition instead, and again at the
  render site in TableModalsLayer, so a tournament cannot show it whichever path
  sets the flag.
- **The showdown.** `applyShowdownRevealRules` lets a hand that cannot win or
  tie any pot stay face-down — the cash-game courtesy. `HandConfig` carries
  `isTournament` now (fed from the engine's existing `isTournamentTable()`), and
  the whole muck branch returns early for a tournament hand, beside the existing
  all-in lock. Every `mucked` flag stays false, so the snapshot, the MUCKED seat
  label, the withheld hole cards and the persisted showdown set all follow from
  that one flag with no special-casing downstream.

## Pinned

`tests/unit/tournamentShowdownAndLobbyRules.test.ts` — the popup refusal at both
sites, the server-side tournament showdown rule and its wiring, zero `:hover`
selectors in the lobby stylesheet, the auto-unfilter and its two guards, the
browser horse-seating refusal, and the derived denominator in both copies.
