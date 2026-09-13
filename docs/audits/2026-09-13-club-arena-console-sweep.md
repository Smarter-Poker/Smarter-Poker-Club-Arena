# Club Arena — upgrade sweep: foundation fixes and the audit of the finished surfaces

Date: 2026-09-13. Checkout: `club-arena` on `main`.
Standard: `#ClubArenaConsole`. Nothing here has been pushed.

---

## 1. What Club Arena is made of

Every page, popup, card, panel, overlay and banner in `src/`, scored by the
standard's own scanner.

|                                          | count |
| ---------------------------------------- | ----- |
| Surfaces in total                        | 217   |
| Already on an approved master (finished) | 36    |
| Still generic                            | 181   |

The 181 break down as 66 pages, 41 popups, 32 panels, 25 cards, 7 overlays,
6 banners and 4 loose components. Of those, 156 have no reference to the master
art at all, 13 carry a `:hover` rule, and 11 are dead — nothing imports them.

---

## 2. Two defects in the shared chassis — fixed

Both live in the kit, not in any one page, so every surface built on the console
inherits them. They were fixed first so the sweep does not bake them into 181
pages.

### 2.1 Plate labels ran past their painted face

`useFitText` shrank a label using a ratio derived from **one** measurement of
the full-size text. Rendered width is not proportional to font-size — glyph
hinting and per-glyph letter-spacing both round — so the result landed a few
per cent wide.

Measured on the console plates at 393px:

| label        | face   | rendered | over       |
| ------------ | ------ | -------- | ---------- |
| Save Changes | 82.8px | 87.09px  | **+4.3px** |
| Copy Rules   | 82.8px | 85.78px  | **+3.0px** |

The final S of "Save Changes" sat on the chrome rim. This breaks two of Dan's
laws at once: _"MAKE SURE FONT SIZES NEVER GO OVER THE EDGES OF THE FRAME"_ and
_"ALL FONTS AND BUTTONS MUST BE CENTERED INSIDE THEIR FRAMES"_.

It had already been hit once, on the header (a 185px zone got a 190px title),
and was patched there by passing an inflated `scaleX` as a private safety
margin — a per-caller fudge, which the standard says not to do. `PlateButton`
never got the fudge, so every plate label on every console surface was over.

**Fix:** the hook now applies its estimate, measures what actually rendered, and
corrects — converging in two passes. The per-caller fudges were removed, and the
prop's documentation corrected so it is not reintroduced.

| label        | face   | rendered | margin          |
| ------------ | ------ | -------- | --------------- |
| Save Changes | 82.8px | 82.5px   | inside by 0.3px |
| Copy Rules   | 82.8px | 82.3px   | inside by 0.5px |

This also corrects the lobby cards, the club identity card and the masthead,
which share the hook.

### 2.2 Desktop was never built

The chassis sizes everything in `cqw` against its own width and had no ceiling,
so a 1440px monitor was handed the phone picture blown up 3.7x: a plate label
rendered at 46px, body copy at 53px, and the 1000px master art was stretched to
1440px, so the chrome and the crest went soft — against _"EVERYTHING MUST BE
CLEAN AND CRISP"_. Only 11 of the app's 495 stylesheets have any desktop rule.

**Fix (Dan's call, 2026-09-13):** the console stops growing at the master's own
width and centres. The art is never asked for more pixels than it has. A surface
that wants to sit narrower sets `--sc-max`; nothing may raise it past the width
of the art.

### Files changed

- `src/components/lobby/game-cards/useFitText.ts` — converging fit
- `src/components/console/SpadeConsole.tsx` — fudges removed, doc corrected
- `src/components/console/SpadeConsole.css` — the desktop ceiling

### Verification

- 4 copy gates: pass. 38 of 50 repo gates pass; the 12 that fail are unrelated
  (see §4).
- `tsc`: 26 errors, all pre-existing missing Capacitor packages in `src/lib/native*`.
  None in any file touched here.
- Tests: 250 pass across the law tests, the console tests and every test
  covering the shared hook's other consumers.

---

## 3. The 36 finished surfaces, audited

Dan asked for these to be reviewed against the standard rather than rebuilt.
They sit on an approved master and their look is pinned by tests, so they are
finished work — but a different dress is not an exemption from the house laws.

**What passes, repo-wide, by the repo's own gates:** Title Case, no em dashes in
anything a player reads, no emoji, no `:hover` beyond four approved dismiss
controls, animations always play, no unread Supabase errors, no `.single()`.

Two laws have **no automated gate**, and both are being broken.

### 3.1 Browns and pinks — 16 of the 36

_"ALWAYS USE SMARTER.POKER COLOR SCHEMA COLORS, NO BROWNS OR PINKS."_

The platform has at least five different golds — brand `#ffd700`, plus `#ffc93c`,
`#d9ac58`, `#d3a855` and `#d4af37` — and most are built as a ramp running from a
light stop down to a dark stop that reads brown. Several are named for it in the
source: `--market-brass`, `--hha-brass`, `--mission-gold-deep`, `--iv-gold-lo`.

Brown dark-stops, verified by hue and lightness:

| surface               | colour                          | what it paints                  |
| --------------------- | ------------------------------- | ------------------------------- |
| InvitePage            | `#8a6d1f`                       | `--iv-gold-lo`                  |
| MemberManagementPage  | `#9b5f06`, `#6e4308`            | gold gradient stop, bevel       |
| PlayerStatisticsPage  | `#4b2d02`, `#b97809`            | bevel, gold gradient            |
| MarketplacePage       | `#8c641c`, `#b8842c`, `#b9852d` | `--market-brass`, gradients     |
| LeaderboardPage       | `#a6673e`, `#a86d11`            | background, gold gradient       |
| ProfilePage           | `#a07a1e`, `#b8902f`            | `--identity-gold`, gradient     |
| DailyChallengesPage   | `#70531f`, `#6e4b17`            | `--mission-gold-deep`, gradient |
| HandHistoryPage       | `#8a6a24`                       | `--hha-brass`                   |
| PlayerWalletPage      | `#9a7a2c`                       | gold gradient stop              |
| ClubMembersPage       | `#6b5937`, `#211a0d`            | border, background              |
| SearchPage            | `#8b6746`, `#5c4a2a`            | borders                         |
| ChipTransferModal     | `#4a2d02`, `#bd7b0a`            | bevel, gold gradient            |
| FriendChallengesPanel | `#7f4e36`                       | border                          |

Genuine mauve (not the brand red — checked against `--accent-red #f02849`,
`--danger-red #ff4757` and `sc-ink--red #ff5b6e`, which are all fine):

| surface     | colour    | what it paints      |
| ----------- | --------- | ------------------- |
| SearchPage  | `#50333a` | `border: 1px solid` |
| FriendsPage | `#51323a` | `border-color`      |

**Worth your eye, not called a violation:** MarketplacePage and CashierTradePage
use very pale red tints as text on dark ground — `#ffd8db`, `#ffc9cd`, `#fff0f2`
and similar. They are in the red family, but they read pink. Your call.

**The one that matters most:** the standard records that InvitePage's gold —
`#d4af37` over `#8a6d1f` — was ruled brown-at-the-dark-end on 2026-09-09 and
replaced with the brand gold. **It was never changed.** Both values are still in
`src/pages/InvitePage.css` today. The written standard and the code disagree.

### 3.2 Decimals on forward-facing pages — 4 of the 36

_"NEVER USE DECIMAL POINTS ON ANY FORWARD FACING PAGE."_

| surface            | what a player sees                                |
| ------------------ | ------------------------------------------------- |
| SessionHistoryPage | "Avg VPIP 24.3%", "Avg PFR 18.7%"                 |
| RakebackPage       | "Latest Period Rate 32.5%" (three places)         |
| UnionGamesPage     | "Contribution Rate 2.5%"                          |
| UnionDashboardPage | commission and rake-hold percentages (six places) |

Not a violation: `SessionHistoryPage` line 228 uses `toFixed(1)` for SVG
polyline coordinates, which nobody reads.

**This one needs a ruling.** Rounding a rakeback rate from 32.5% to 33% changes
a number a club owner is paid on, and the same law says never overstate. The
rule reads as written for chip counts. Whether it binds percentage rates is
Dan's call, not mine.

---

## 4. Defects found on the way, unrelated to the picture

- `check-chip-conservation` fails on live data: **289 op-id claims stranded
  unfinalized over an hour**. This is money, not paint, and nothing in this work
  touched it. Flagged for someone to look at.
- `check-no-vercel-deploy` fails because it is matching its own source text
  inside a stray `.agent-trees/agent-compliance/` worktree sitting in the repo.
  Repo clutter, not a real deploy path.
- Five gates need Supabase or GitHub credentials and cannot run here.
- A stale `.git/index.lock` was stranded in the checkout and has been cleared.

---

## 5. What happens next

The 181 go in batches of six to ten, one theme each, in traffic order — the felt
and the money pages first, admin last. Each batch is rendered before and after
at 393px and at desktop, every state, and shown before anything is pushed.

The 11 dead surfaces are not worth a redesign; they are worth deleting.

---

## 6. Rulings received 2026-09-13 (after the audit above)

- **Desktop:** the console stops at the master's own width (1000px) and centres.
- **The 36:** reviewed against the house laws, not rebuilt.
- **Decimals:** percentage rates keep one decimal. The no-decimals rule was
  written for chip counts; rounding a rate misstates money.
- **Gold:** two tokens with jobs. Brass `#d6ad52` is the warm accent wherever the
  no-yellow law test already requires it; brand gold `#ffd700` is for things
  that are genuinely gold. Not five accidental golds.
- **Every colour is a schema colour.** No derived or invented tones, dark ones
  included. An attempt to replace the brown dark stops with darkened versions
  of themselves was rejected on sight and reverted: it produced 24 new
  non-schema colours. The schema's own gold ramp is `--gradient-gold`
  (`#ffd700` to `#ffa500`) in `club-engine.css`, which is the only token sheet
  `main.tsx` actually loads; `design-system.css` and `globals.css` are not
  imported at runtime.
- **Variety:** one frame with five badges is not enough. New frame families may
  be cut from the master. Every crest must match the spade's quality - high
  definition, dimensional, mitred into the rails. The club, diamond and crown
  crests do not, and are to be repainted. Painting needs the gpt-image-1
  pipeline in `source/README.md`; no image key is present on the Mac.

## 7. The schema mapping for the browns - PROPOSED, not applied

24 browns across 13 of the 16, by role. Each maps to a colour the schema
already owns.

| role                   | count | maps to                                                                                                                 |
| ---------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------- |
| gradient dark stop     | 9     | `#ffa500`, the dark end of the schema's own `--gradient-gold`                                                           |
| brass / gold-lo tokens | 5     | `#d6ad52` brass where the surface is a warm accent, `#ffd700` where it is gold                                          |
| bevel / shadow         | 2     | `#050607`, the console's own bevel dark (the spade console's engraved silver uses it)                                   |
| warm border            | 7     | `rgb(214 173 82 / 45%)`, brass at reduced alpha over black - the same technique the console uses for its engraved rules |
| flat background        | 1     | context needed (LeaderboardPage `#a6673e`)                                                                              |

Mauve borders on the two danger controls (`#50333a`, `#51323a`) map to
`--accent-red #f02849`.

This touches 16 finished pages. Render before and after, show, then apply.
