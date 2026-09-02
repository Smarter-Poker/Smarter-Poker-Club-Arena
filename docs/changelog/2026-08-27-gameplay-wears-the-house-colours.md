# 2026-08-27 — Phase 4: gameplay wears the house colours

Session: Cowork (Claude). Dan: "GAME PLAY MUST LOOK LIKE THE CLUB ARENA."
Shipped as **PR #1437** (merge `f465a9b68f`). Verified in the bytes production
actually serves, not just the commit graph — see Verification below.

> A second agent worked the same phase in parallel from a different angle and
> filed `.agent/audits/2026-08-27-gameplay-looks-like-the-club-arena.md`
> (emoji/PokerBros rules, the mock ClubProfileModal). That work and this are
> complementary; the only overlap was one stale colour fallback in their new
> file, fixed here.

## The root cause was three tokens, not carelessness

| token                               | value     | consumers                 |
| ----------------------------------- | --------- | ------------------------- |
| `--success-green` (club-engine.css) | `#00d26a` | 13                        |
| `--success` (globals.css)           | `#31a24c` | 20                        |
| the house green (Dan's, #1365)      | `#3fb950` | 47 literals, **no token** |

Three live semantic "success" greens, none aware of the others. That is why
every hand sweep kept finding "the last" stragglers — #1365 swept "the last
three legacy greens" in RunItTwice.css; there were **133 more, in 36 shades**,
across the rest of the table. Literals could never converge while the tokens
themselves disagreed.

## What shipped

- **All semantic tokens unified to `#3fb950`** — `--success-green`,
  `--success`, `--color-success`, `--stack-normal`, the dead
  `--color-check`/`--color-call`, and every `-glow`/`-dim` rgba twin. That one
  change re-points ~35 consumers across the table _and_ the lobby.
- **103 literal greens** across 29 gameplay files swept to the house family:
  `#3fb950` base / `#4dc660` light / `#2ea043` dark. Semantic only.
- **17 more greens laundered through `rgba()`**, invisible to a hex sweep —
  including the "it's your turn" attention pulse on the action panel. Both
  previous sweeps missed this layer, so the old green was still haloing the new.
- **Action buttons**: raise and all-in stay GREEN (Dan's item 8 — the
  blue/green split is how a player reads passive vs aggressive without
  reading), but they ramped `#34d374 → #16a34a → #0b5426`, a shade found
  nowhere else in the product, on the control the player looks at most. They
  now ramp the house family the Cashier and Sit-Out buttons already wore.
- **The four-colour deck disagreed with itself** (found by accident). The tab
  bar draws a mini preview of each table's hand, and _all four_ suits had
  drifted to a second shade — spades `#111318` vs `#1e293b`, hearts `#dc2626`
  vs `#ef4444`, diamonds `#2563eb` vs `#3b82f6`, clubs `#16a34a` vs `#22c55e`.
  The same card was one colour in the preview and another in the hand it
  previewed. `CardImage.tsx` `SUIT_COLOR` is the source of truth; the tab bar
  matches it now. Suit greens stay OUT of the house scheme — a readability
  convention, not brand.

## The part that makes it stick

`tests/gameplay-wears-the-house-colours.test.ts` scans every gameplay file for
green hex **and** green `rgba()`, failing on anything outside the house family
or an explicit `EXEMPT` entry — card suits, chip denominations, user-selectable
skins, particle art, WhatsApp's own brand green — each naming the file it may
live in and why. Comments are stripped first, so files that deliberately quote
the shade they replaced do not fail on their own explanation.

It is not decorative:

- planted `#22c55e` + `rgba(16,185,129)` in SeatSlot.css → **both checks
  failed**; removed → green again;
- on the merge with main it caught drift it was **not** planted to find: the
  rebuilt `ClubProfileModal.css` reached for `var(--color-success)` correctly
  but left the fallback at `#22c55e`. Fixed in this branch.

## Verification (production bytes, not the commit graph)

`https://smarter.poker/hub/club-arena/assets/index-dtVGkJUM-v6.css`:

    --success-green: #3fb950   --success: #3fb950
    --color-success: #3fb950   --stack-normal: #3fb950

Shipped `TablePage-*.css` chunks: `#3fb950` ×104, `#4dc660` ×15, `#2ea043` ×13;
old action ramp `#34d374` ×0, `#0b5426` ×0; old `--success-green` `#00d26a` ×0;
the house ramp `#4dc660,#3fb950 40%,#2ea043` present twice (raise + all-in).

tsc clean · 461 test files / 7324 tests · production build succeeds.

## Known, bounded gap — deliberately not swept

The guard covers `src/components/table/**` and `src/pages/TablePage.css`. Five
`#31a24c` literals still ship in the TablePage chunk from components _outside_
that scope: `src/styles/design-system.css`, `components/tournament/SpinWheel.css`,
`PayoutStructure.css`, and several admin/auth pages. The **lobby** is in the same
state gameplay was (`#10b981` ×14, `#22c55e` ×12, `#00ff88` ×8). Extending the
guard's file list is the obvious next phase; it was left out of this one so the
diff stayed reviewable and stayed on what Dan asked for.

## Note for the next agent

Three files — `RebuyModal.css`, `TimerBar.css`, `SessionStatsTracker.css` —
show large diffs. That is the repo's own lint-staged Prettier reformatting
files that had never been formatted (4-space → 2-space), triggered because this
change touched them. No rules changed in them beyond colour.
