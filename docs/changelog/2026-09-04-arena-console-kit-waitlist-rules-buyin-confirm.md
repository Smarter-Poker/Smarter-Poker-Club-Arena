# 2026-09-04: The spade console, and four generic surfaces rebuilt on it (approved by Dan 2026-09-08)

Dan, 2026-09-04: "find me 2 pages, and two pop ups in the club arena, that
haven't been upgraded by us and are 'still generic' ... 'redesign them' the way
i would want. Do not push or publish anything you've done until i've approved."

## The four surfaces

| Surface                   | Where a player meets it                             | Was                                                       |
| ------------------------- | --------------------------------------------------- | --------------------------------------------------------- |
| My Waitlists page         | JOIN WAITLIST on a full table, then the queue       | rounded cards, gradient progress bar, ghost Leave button  |
| Club Rules page           | the club's rules from the lobby menu                | navy card under a plain heading, rounded blue Edit button |
| Buy-In popup              | JOIN TABLE, every time a player sits down           | rounded glass sheet, pill buttons, gradient BUY CHIPS     |
| Confirm popup (10 places) | Close Table, Leave, Remove, Delete across the arena | circled warning glyph, grey / red pill buttons            |

Before renders: `outputs/before-*.png`; round three: `outputs/round3-sheet.jpg`.

## Round three (Dan's review of round two)

Dan: the buttons were trash, the crest was stuck on, the tops of the frames
were distorted, frames sat on frames, backgrounds everywhere, fonts that
did not belong to the render, plates copy-pasted, pills cheap. All of it
came from one mistake: assembling surfaces from small parts (the 900px
shark-panel rails, plate PNGs, bay PNGs, CSS pills) at phone scale. So
nothing is assembled any more:

- **Buy-In is Dan's spade PLO master itself** (`popups/buy-in-v1/chassis.png`,
  1000 x 1135) with its four painted bay labels inpainted out. Table name
  and BUY-IN in the header well, the countdown in the well's painted pill
  slot, the slider riding the chrome rule the master paints across the well,
  the bays printing MIN / CHIPS / MAX / BALANCE, CLOSE / BUY CHIPS on the
  plates painted into the foot. MIN and MAX are tappable and snap the
  amount; an unknown balance (main's 2026-09-04 `accountBalance: null`)
  prints Unknown and tapping its bay retries.
- **Confirm, Club Rules and the empty waitlist are the spade console**
  (`console/spade-console-v1/`): the same master cut at full resolution into
  head (crest seated in the rail, header well, pill slot, chrome rule), an
  averaged rail strip that repeats, and a foot with the painted plates or
  the closing rail and chip. Text prints on the glass between them.
- **My Waitlists draws the lobby's own card for each queued table** - the
  approved NLH / PLO / Short Deck masters - with the queue state in the
  card's painted pill slot (`#3 In Line`, `Next Up`, `Seat Held 0:42`) and
  WATCH TABLE / LEAVE WAITLIST (or SIT NOW) on its painted plates.
- **No CSS pills, no drawn plates, no inset wells, no 900px art.** The only
  drawn control left is the Buy-In slider's lit run and knob, on the rule
  the master paints.
- **A lobby bug found on the way:** the NLH premium card baked VIEW TABLE /
  JOIN TABLE into its plate art, so a full table read JOIN TABLE while the
  action was Join Waitlist, and your own seat read JOIN TABLE while it was
  Return To Game. The two plates now ship label-free
  (`buttons/view-plate.png`, `buttons/join-plate.png`, words inpainted out)
  and the card prints the action it performs, in the plate's ink. The
  `statusTone` field on `ArenaGameCardData` lets a caller print a label
  verbatim in the pill (`premiumStatusBadge`).

Renders at 393px with the real fonts: `outputs/round3-sheet.jpg`.

## Round four (Dan's review of round three: "these look so much better")

Four corrections, all applied to the master itself so every surface drawn
from it (the lobby's PLO card included) gets them:

- **One background per card.** The spade chassis's header well carried two
  tones: the band where the card's title had been inpainted was lighter than
  the untouched glass beside it. The well interior is now the approved
  reference's own texture, verbatim, with only the three painted words
  (PLO 2/5, ANTE, EMPTY) lifted out by texture synthesised from the same
  well and matched to the local brightness. No band, no seam.
- **Full-colour plates.** Both plate faces (steel and blue glass) carried the
  inpaint band where VIEW TABLE / JOIN TABLE had been, which read as a
  different background inside the button. Each face is now synthesised
  edge to edge from its own untouched margin, so the bevel gradient runs
  the full height and nothing sits inside it. The NLH card's two plates
  (`view-plate.png`, `join-plate.png`) got the same treatment.
- **No decimals on a forward-facing page.** Buy-In prints whole chips
  everywhere (floored, so a display never overstates); the amount actually
  bought in for keeps its exact value.
- **Smarter.Poker colours only.** The pale-rose red ink (`#ffd0d2`) and the
  cream-on-amber gold (`#ffeeb3` over `#f1b83a`) are gone from the console,
  the layered cards' pills and the NLH card's plate labels; red is
  `--accent-red` (#f02849 glow, #ff5b6e ink) and gold is `--accent-gold`
  (#ffd700). Green and blue were already the schema's.

`outputs/round4-sheet.jpg`.

## Round five (Dan 2026-09-08: "everything else is perfect")

- **Labels never leave the frame.** Every printed plate label (the layered
  cards, the NLH card, the console plates) is now fitted to the plate's FACE
  (the well inside the chrome rim, ~80% of the zone) instead of the whole
  zone, so LEAVE WAITLIST shrinks before it can touch the rim.
- **Hold'em buy-in side by side.** The NLH card prints minimum and maximum on
  one line (still no dash), fitted as a pair; the PLO family keeps the stack.
- **1K / 1.2K / 10K.** One compact figure for every printed chip amount
  outside the felt (`compactChips` in `utils/format.ts`): whole chips under a
  thousand, one decimal above it, always rounded down. The card adapter and
  the Buy-In bays share it. The felt's `formatTableChips` law is untouched.

`outputs/round5-sheet.jpg`.

Approved 2026-09-08 ("everything else is perfect") after one last cut: the
console plate labels fit 70% of the plate and start at 4.2cqw, so BROWSE
TABLES sits inside the blue glass with air on both sides.

## The kit: `src/components/console/SpadeConsole.tsx` + `.css`

`SpadeConsole` (eyebrow, title, subtitle, pill, body, foot 'plates' | 'foot',
plates {secondary, primary}), `PlateButton` (a transparent button over a
painted plate: label only), `ZoneText` (fitted one-line text in a measured
zone), `zonePct`, and the ink classes `sc-ink--silver / white / blue / green /
red / gold / muted` in the master's own colours. Every size is cqw against the
console; solid silver with a bevel, never a clipped gradient; no `:hover`.
Inside a dialog the global `metallic-popups.css` chassis (which bevels,
recolours and rounds every button with `!important`) is switched off at
higher specificity, longhand by longhand.

## What changed under the paint (real defects)

- **My Waitlists printed "No Limit Hold'em" with an empty stakes string for
  every row** because the page hardcoded both. `WaitlistService.getUserWaitlists`
  now resolves the table's lobby row (`table` on the entry, plus
  `tableVariant` / `tableStakes`) and the page draws the table's own card.
- **A 'notified' row (seat offered, sixty-second hold) printed "#0 In Line".**
  It is now SEAT HELD with the live countdown to `hold_expires_at` in the
  pill, and SIT NOW on the blue plate takes the player to the table.
- The NLH card's plate labels now say what the action is (above).
- Buy-In: MIN / MAX bays are real buttons with `aria-pressed`; the slider has
  an accessible name; the unknown-balance state has a retry.
- Confirm gets `aria-describedby` and `aria-busy` while working.

## Untouched

Every handler, guard and prop: Escape / backdrop / countdown behaviour of
Buy-In, `onConfirm(amount, false)`, the cashout-restriction notice, Top Up,
ConfirmModal's props and the ten call sites, ClubRulesPage's load / save /
role checks, WaitlistPage's realtime and bus subscriptions.

## Gates (local)

`tsc` clean; prettier; `check-ui-text`, `check-title-case`,
`check-painted-text-case`, `check-nav-title-case` OK; vitest: popup system,
felt-reachable (pin moved to `titleId=`), WaitlistService, buy-in window /
idempotency / seat guards, no-hover law, law registry, club buttons, lobby
controls: 208 tests green.

## Round six (Dan 2026-09-08): three more surfaces, and the frame itself

Dan: "PICK 3 MORE AREAS THAT ARE IN NEED OF THE SAME TYPE OF UPGRADES ... GIVE
ME SCREENSHOTS OF WHAT THEY LOOKED LIKE BEFORE, AND WHAT THEY LOOK LIKE AFTER."

| Surface            | Where a player meets it               | Was                                                                  |
| ------------------ | ------------------------------------- | -------------------------------------------------------------------- |
| Rebuy popup        | busting out of a tournament           | rounded navy card, five text rows, grey / blue pills                 |
| Wait List popup    | the queue on a full table             | circled position badge, avatar discs, grey header, red pill          |
| Club Announcements | the club's noticeboard from the lobby | rounded cards, yellow pinned stripe, cyan bar, outlined Pin / Delete |

Rebuy is Buy-In's sibling on the same deck (bays print COST / FEE / CHIPS /
BALANCE, the total is the figure the server debits); the Wait List and the
noticeboard are the spade console. Every printed figure is `compactChips`.
Handlers, guards and the tests that pin them are untouched: the rebuy still
gates on cost + fee, the wait list still confirms before it drops your place,
and the noticeboard's pin / delete still read their RPC's answer.

### The lines coming out of the frames

Dan: "THEY SHOULDN'T HAVE THE LINES BEHIND THEM, WHERE THEY APPEAR LIKE UNDER
THE FRAMES ... THEY SHOULD JUST BE STAND ALONE IMAGES WITH FRAMES AROUND THEM."

The three slices were three background layers on the CONSOLE, and the rails
(`mid.png`) repeated over its whole height - so they painted in the
transparent margin above the crest and below the closing rail, where the head
and the foot draw nothing. Each slice now paints its own box: the head is the
head, the rails run only beside the body they carry, and the foot closes it.
Same fix in Buy-In and Rebuy, whose master is built the same way.

**The same defect is still live on two surfaces this round did not touch**:
`.glp--cash .glp__section` (the desktop cash lobby panel) and `.dbs__panel`
(the daily bonus sheet) tile `shark-panel-v1/mid.png` behind the whole
element, and that art is transparent for its first 33 rows. A pseudo-element
inset to the caps fixes it (proved on a probe); `background-clip: content-box`
does NOT - it clips the side rails away too.

### A flat bottom, and the spade at the top

Dan: "I ACTUALLY PREFER IT WITH ONLY AN ICON AT THE TOP, IM NOT A HUGE FAN OF
THE CHIP ON THE BOTTOM. AND WITH NO ICON ON THE BOTTOM, IT SHOULDN'T POINT OUT
STILL ON THE BOTTOM. IT SHOULD BE A FLAT BOTTOM."

The closing cap is now the master's OWN top rails turned over: the same rails,
the same four corner chamfers, no chip and no dive to the centre. Nothing is
drawn that the master did not already contain, and every printed zone stays
where it was - only the foot's height changes (257 -> 72 plain, 435 -> 277 with
plates, and the Buy-In deck 785 -> 627), so the plate and bay zones are
re-based on those canvases.

A long title beside a pill now stops with air before the pill's slot;
ANNOUNCEMENTS was running up against its rim.

## Round seven (2026-09-09): the standard becomes a kit, and the sweep starts

Dan: "UPGRADE AND ENHANCE IT AS BEST AS YOU CAN SO ANY AND ALL AGENTS CAN DO
WHAT YOU ARE DOING HERE", then "UPGRADE EVERY REMAINING PAGE, SUB PAGE, POP UP,
BUTTON, FRAME AND ANYTHING ELSE INSIDE EVERY CLUB ARENA PAGE".

### The kit

`.claude/skills/club-arena-console/` is no longer only prose:

- `scripts/master_surgery.py` - every technique for deriving art from an
  approved master (`median_bridge`, `synth_fill`, `synth_fill_matched`,
  `axis_of_symmetry`, `mirror_close`, `flat_cap`, `splice`), plus `column_runs`
  and `is_straight` for measuring the art before cutting it.
- `scripts/find-generic-surfaces.mjs` - scores all 245 surfaces in `src/` by
  distance from the standard and prints an importer count: 80 are already on a
  master, 165 are not, and 31 of those have no importer at all.
- `harness/` - the render harness and the before/after sheet builder, so a
  review picture is four commands rather than an afternoon.
- `tests/the-console-standard-stays.law.test.ts` pins the skill, its kit and
  its pointer in CLAUDE.md, because a standard that can be deleted quietly is
  a standard that will be.

### Two rules the sweep paid for immediately

- **Two actions or none.** The foot paints BOTH plates, so a surface with one
  action leaves the other painted and empty - which reads as broken, not spare.
  One way out uses the flat cap and a lit word on the glass.
- **Prove the surface is alive first.** `FoldProtectionDialog` was rebuilt on
  the console before anyone checked: it is not on `origin/main` and nothing has
  imported it for weeks. The scanner now prints importers and marks `DEAD?`.

### Batch one: the felt

| Surface            | Was                                               | Now                                                                                                                 |
| ------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| All-In Insurance   | rounded sheet, drawn pills, horizontal fee slider | the spade master's three slices, countdown in the painted pill slot, fee slider vertical, NO / INSURE on the plates |
| Game Rules         | navy card, tab pills, `×`                         | the console; tabs as lit words, CLOSE / HAND RANKING on the plates                                                  |
| Time Bank Store    | rounded sheet, five CSS preset pills              | the buy-in deck: PRICE / BANKS / HELD / TOTAL in the bays, presets as lit numerals, NOT NOW / BUY on the plates     |
| Table Load Failure | 90 lines of inline style, 14px radius             | the console; one way out uses the flat cap and a lit word                                                           |

Insurance keeps every figure exact to the cent except the headline pot: those
are the terms of the contract being bought, and a rounded display once charged
76.66 for a dialog that said 75.62. Every handler, focus trap, countdown,
single-flight guard and pinned literal survived; `classNamesResolve` fell from
41 unresolved names to 36 on the way.

## Round eight (2026-09-09): the sweep, waves one and two

Dan: "UPGRADE EVERY REMAINING PAGE, SUB PAGE, POP UP, BUTTON, FRAME AND
ANYTHING ELSE INSIDE EVERY CLUB ARENA PAGE THAT NEEDS THE #ClubArenaConsole
UPGRADE."

### What the inventory actually found

The first pass counted 165 generic surfaces. It was wrong twice over, and both
corrections are now in the scanner:

- **31 have no importer at all.** `FoldProtectionDialog` was rebuilt on the
  console before anyone noticed it is not on `origin/main` and nothing has
  imported it for weeks. The scanner prints an importer count and marks `DEAD?`.
- **Another 14 are already on a different approved master.** Club Arena has
  more than one visual authority - the spade console, the #SmarterCasinoRealism
  cinematic routes (Daily Challenges, Player Stats, Leaderboard, Notifications,
  Search, Friends), the community and account surface headers, and one page Dan
  art-directed himself (Invite, black glass and gold, 2026-08-28). Their tests
  pin bevel frames, conic gradients, named animations, a horizontal snap rail
  and exact hexes - the precise shapes this standard forbids. The scanner now
  reads the tests: any surface named inside a test that pins a LOOK is off the
  sweep, and stays that way.

**102 surfaces are genuinely generic and live.** 21 of them are done.

### Rebuilt in these two waves

Wallet cashier, deposit / withdraw, cashout request; player statistics,
achievements; clubs and club discovery; tournament lobby and its cards, XMTT,
tournament info, mystery bounty, final table, heads-up, the sign-up dialog;
create club, join club, find player, complete profile, the welcome door, block
player.

### Defects found on the way, all fixed

- **Two competing compact formatters.** `chipsCompact` rounded UP (1,250 read
  "1.3K", overstating what a player holds) and kept the tenth on a round figure
  ("5.0K", a decimal on a forward-facing page). It delegates to `compactChips`
  now - one formatter, Dan's rule, 25 call sites corrected at once - and the
  test that pinned "1.3K" moved with it.
- Tournament payouts and the final-standings podium printed decimal prizes; the
  podium's 1st/2nd/3rd printed empty strings where an emoji had been stripped.
- Club discovery printed its top three clubs twice (a "featured" rail above the
  same list), and was a clickable `div` with a nested button, so a keyboard
  could not open a club.
- The welcome door - a blocking modal - announced as nothing: no `role`, no
  `aria-modal`, no accessible name.
- A tournament card's title carried the guarantee and truncated
  ("5K GTD SUNDAY DEEPSTAC"); the guarantee already prints on its own row.
- `GameRulesModal` restated a house colour as a raw hex, which the gameplay
  palette law reads and rightly refuses; it uses the console's ink class now.

### Two rules the sweep paid for

- **Two actions or none.** The foot paints BOTH plates, so one action leaves the
  other painted and empty. One way out uses the flat cap and a lit word.
- **The four-bay deck belongs to the buy-in family.** Dan: "I DON'T LIKE THE 4
  BOXES, AND THE WAY IT STICKS OUT ON THE SIDES." Every other surface prints
  rows on the glass.

## Round nine (2026-09-09): waves three and four

Thirteen more surfaces on the master: the operator pages (drift incidents, club
financials, table config, agent management, admin dashboard) and the table-side
panels (hand detail, hand history, table settings, must-move lobby, tournament
winner, hero hub, table leaderboard, table cashier).

### The inventory learned to read the tests properly

Three corrections, each one a surface it would otherwise have handed to an agent
to break:

- **A test's SUBJECT, not its body.** The detector scanned whole files, so a
  passing mention of "cinematic" in an unrelated test marked `TablePage` - the
  most generic surface in the app - as spoken for. It reads `describe()` / `it()`
  titles and filenames now.
- **A colour law is not a look.** `gameplay-wears-the-house-colours` and the
  settings palette test bind every surface, console ones included; treating them
  as "already mastered" hid four more pages.
- **Spaced and capitalised markers, and paths without extensions.** A test
  titled "Players Casino Realism" that imports `'../../src/pages/X'` and reads
  `X.css` pins X - the old regex saw none of those three forms, and offered up
  `MemberManagementPage`, which carries an approved credential render.

Final count: **134 surfaces spoken for (36 by a visual test), 81 genuinely
generic and live.** 34 are done.

### Judgement calls the agents made, and were right to

- `BombPotOverlay` was reported back rather than rebuilt: it is felt cinematics -
  a falling bomb, a wick, a fireball, embers - with no frame, plate or button in
  it, `aria-hidden` and `pointer-events: none`. Putting a painted console frame
  there would put a frame back over the community cards at exactly the place Dan
  ruled it must move away from.
- `TournamentRankingCard`, `MemberManagementPage`, `GameManagementPage` and
  `ClubDataPage` were left alone: each is pinned by a written contract to
  another master (a medal palette, a credential render, a table-command hero, a
  data-vault hero).

### Defects fixed on the way

- The table leaderboard rendered its list from `players.slice(3)`, so the top
  three appeared ONLY in the podium tiles - which the rebuild deletes. Every
  player is in one ordered list now, and 1st / 2nd / 3rd still say so.
- `ClubFinancialsPage` defined `.summary-card`, `.card-value`, `.card-label`,
  `.period-selector` and `.export-btn` unscoped, and `RakeReports` - which that
  page renders inside itself - defines all five. Whichever loaded second won.
- `TableConfigPage` printed `NOT AVAILABLE YET` through a class that named no
  rule anywhere, so the one control that tells an operator a game type is off
  rendered unstyled.
- Two rebuilt sheets defined a global `slideUp` differently; both are prefixed.

## Round ten (2026-09-09): the daily bonus, the club and agent components, and a ruling

### The daily bonus

Dan: "FIX THE CLUB ARENA DAILY BONUS ... ITS SO TRASH." The screenshot said
why - a plaque inside every tile inside a grid, three more plaques across the
top, seven for the week, and an icon in a well inside a plaque inside a card.
Frames on frames on frames, the one thing ruled against since the first review.

It is one picture now: the console, with the three readouts as rows, the week
as a single line of lit numerals (behind you in green, today in white, ahead
muted), and each reward as a row - its own render, the label, the figure, and
CLAIM as a lit word on the same line. The claim burst still plays.

Two things the render caught: a claimed reward printed its own label twice
("Rabbit Hunts / Rabbit Hunts"), and the VIP row's figure landed on top of its
label because `.sc-label` refuses to wrap - right inside a painted zone, wrong
in a row sharing width with a figure and an action.

### Ruling: the front door keeps its own dress

`InvitePage` is generic by every measure the scanner has, and it is staying off
the console. Dan art-directed it against three reference cards on 2026-08-28
and it is the one surface a person who is NOT a member ever sees. This standard
governs the inside of the arena. Dan handed the call over ("THAT RULING IS ON
YOU TO DECIDE") and that is it - recorded in the skill so nobody re-opens it.

A different dress is not an exemption from the house laws, though: its gold was
`#d4af37` over `#8a6d1f`, a ramp that reads brown at the dark end, and "NO
BROWNS OR PINKS" has no exceptions. It is the brand gold now.

### Club and agent components

Club card, ticker management, create tournament, player invite, commission
history, agent cashout and chip mint, all on the console; rake snapshot left
alone (a registered law mandates its multi-column grid) and the club-side
CashierModal reported dead (nothing imports it; the table's own file of the
same name is the live one).

Defects fixed: a search button whose label was the empty string, and a stack of
generic global class names (`.panel-header`, `.count-badge`, `.player-name`,
`.amount-value`, `.empty-state`) that leaked out of the agent cashout panel.

## Round 11 (2026-09-13): the merge took main's generic versions of eleven approved surfaces. Restored.

Merging 430 commits of `main` on 2026-09-13 resolved every conflicted
file to main's side, on the rule that product logic beats paint. It was
the right rule and the wrong outcome: eleven of the files were the
approved console renders themselves (Buy-In, Rebuy, table Cashier,
Table Rules, Cashout Request, Club Card, Welcome, Complete Profile,
Tournament page, Tournament Info, Sign Up), and main's side of each was
the OLD generic render plus a small logic delta (24, 7, 26, 92, 37, 122,
38, 23, 3, 2 and 24 lines). Taking main threw away the render to keep
the delta.

The repair applied main's delta ONTO the console render
(`git checkout d8d5bb296 -- <file>` then `git apply -3` of
`git diff e658bea44 origin/main -- <file>`) and resolved the eleven
conflicts by hand: every line of main's logic survives (verified by
`git diff -w origin/main` showing only chassis differences), every
pinned literal survives, and two label pins moved with the render
(`( Available Diamonds:` -> `Diamonds`; `Entry Fee:` -> `Entry Fee`).

Defects found in the approved renders while restoring them, fixed:
Buy-In's long plate labels lost their last glyph to the rim (labels
over twelve characters now wrap to two centred lines on an 80% well);
the recovery state's amount block fell into the empty slider column;
Sign Up's plates carried the global `btn` class, whose
`justify-content: center` collapsed the well to 26px ("CANC"/"CONFII");
`club-engine.css` turns every `<table>` under 768px into a
shrink-wrapped scroll box, so Tournament Info's ranking rows were 40%
wide; `metallic-popups.css` repainted its Close as a steel pill.

Also in this round: stylesheets that had followed my render while the
merge took main's TSX (`CompleteProfileModal.module.css`,
`ClubArenaWelcomeModal.module.css`, `CreateTournamentModal.module.css`,
`signUpDialog.css`, `TournamentPage.css`, `ClubMessageManagementPanel.module.css`)
were re-paired; `InsuranceModal.css` dropped the `/hub/club-arena`
asset prefix (`every-file-the-user-gets-goes-through-one-door` law);
`TableConfigPage` and `TickerManagementPanel` took main's #4519 versions
outright (board test contracts) and go back on the inventory.

Lesson for the skill: a merge conflict between a console render and a
main change is never resolved by taking a side. Rebase the delta onto
the render.
