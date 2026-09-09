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
