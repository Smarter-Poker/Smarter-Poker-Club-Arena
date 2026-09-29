# The console inventory was scoring the standard against itself (2026-09-22)

The #ClubArenaConsole sweep had four rows left. Two of them were mine to close:
`src/components/leaderboard/LeaderboardSettlementCard.tsx` (score 3) and
`src/components/common/Card.tsx` (score 6).

**Neither one was a rebuild.** Both were the inventory reporting work that does
not exist, for two different reasons, and both reasons are now fixed where they
were caused rather than worked around on the row.

The sweep reads **zero to go** on the surfaces this task owned. `ClubAdvertisePage`
closed under it while these checks ran - #5083 rebuilt it on the console - so
after merging `origin/main` the inventory prints **233 spoken for, 1 to go**, and
the one remaining row is `PokerArenaLandingPage` (16), another agent's
workstream. Neither was touched here.

---

## 1. A zeroing declaration is not chrome

`LeaderboardSettlementCard` scored 3. Its entire stylesheet contains exactly two
lines the scanner could see:

```css
border-radius: 0;
box-shadow: none;
```

That is the whole score. `radius * 2 + grad + hover * 5` = `1*2 + 1 + 0` = 3.

Those two declarations do not draw a frame. They **refuse** one, and they are
this standard's own handwriting: SKILL.md 3.5 tells every surface inside a
dialog to switch the `metallic-popups.css` chassis off longhand by longhand with
exactly `border-radius: 0` and `box-shadow: none`, and a surface printed as rows
on console glass unpaints its buttons the same way. So the scanner was counting
correct compliance as evidence of non-compliance: **the more carefully a surface
followed 3.5, the more generic the inventory said it was.**

The card itself has been finished work since `15477de6f1` (#4521, "adopt the
approved painted console across rankings"). `LeaderboardPage.tsx` opens a
`<SpadeConsole>` at line 1225 and renders `<LeaderboardSettlementCard>` at line
1949, inside it, closing at 1965. The card owns no frame at all: it prints as
rows on the board's glass, label in lit blue on the left, value in silver or
gold on the right, exactly as Step 5 of the standard prescribes for a surface
with figures but no chassis of its own, and exactly like `BBJBasicPanel`, which
the scanner already rules off for that reason. Its stylesheet's own first line
has said so since the day it landed:

> `/* Settlement is live ink inside the board's console, never a nested frame. */`

**Fixed at the root.** `find-generic-surfaces.mjs` now reads each
`border-radius` and `box-shadow` **declaration** and judges its value, so a
zeroed corner and a refused shadow count for nothing. That closes the class of
false positive, not just this row: every surface that correctly unpaints a
dialog chassis was accruing score for it.

It is counted by value rather than by a negative lookahead, because
`\s*` before a lookahead backtracks to zero width and the lookahead then passes
on the space. `/border-radius\s*:\s*(?!0...)/` matches `border-radius:` inside
`border-radius: 0;` and happily reports a painted corner. The first version of
this fix did exactly that and changed nothing; read the declaration, then judge
it.

The fix does not blind the tool. `ClubAdvertisePage` went 34 to 33 (it has one
`box-shadow: none`) and stayed nominated on thirteen real corners and seven real
gradients until #5083 rebuilt it; `PokerArenaLandingPage` is unchanged at 16.
97 surfaces still report a painted corner and 156 a painted shadow or gradient.

### No defects found in the card

Every state was rendered at 393px and read for the copy and figure laws before
this was called finished. Title Case holds in all of them, including the two
strings that arrive as data: `failure.owner_message` is authored Title Case in
`20260906084547_leaderboard_phase_4_promo_only_settlement_truth.sql`, and the
one client error literal is `'Period Settlement Could Not Be Verified.'`.
Chips print through `compactChips` (`1.2M Chips`, `180K Chips`), the countdown
is gold, the delayed state is the schema red, and nothing paints outside the
frame. The sheet is
[`shots/2026-09-22-settlement-card-on-the-board-console.jpg`](./shots/2026-09-22-settlement-card-on-the-board-console.jpg):
round open, payouts verified, settlement delayed with the owner message,
verifying, and status unreadable.

There is no before/after pane for this row because **no pixel changed**. The
before would be the after. The five states are the evidence for the ruling, and
the real before/after in this delivery is the inventory's own output, printed
below.

---

## 2. A primitive nothing renders is not a surface

`src/components/common/Card.tsx` scored 6, and unlike the settlement card its
paint is real: `border-radius: 12px`, three box-shadows and a gradient. The
scanner was right about the CSS. It was wrong about the row, because **nothing
renders it.**

Read, not assumed:

- Zero JSX sites in `src/` for any of its six exports - `Card`, `CardHeader`,
  `CardContent`, `CardFooter`, `StatCard`, `FeatureCard`.
- The three `<StatCard` render sites in the tree are three different components:
  `ProfilePage.tsx:197` and `ClubDetailPage.tsx:241` each define their own local
  one, and `src/components/stats/StatCard.tsx` is a separate file exported from
  `src/components/stats/index.ts`. A name-only scan reads those as proof the
  primitive is alive. It is the same collision the importer count was taught
  about on 2026-09-21, one level further in.
- Its only importer is the barrel `src/components/common/index.ts`, and the
  barrel's only importer is `src/main.tsx:55`, which takes `ErrorBoundary`
  alone.

So it is reachable by the import walk and unreachable by any player, which is
why `every-file-under-src-is-reachable.law.test.ts` cannot hold it off the sweep
the way it holds the other nine. Painting a chassis onto it would change nothing
on any screen.

It is now in the scanner's `RULED` map with that ruling and its evidence.

### Retiring it is the right answer and it is not free

Deleting the component is trivial. Deleting `Card.css` is not, and this is the
part that makes it a separate delivery rather than a sweep row.

`Card.css` is a **global** stylesheet, not a module, and it is still the only
declaration of three properties that five live surfaces inherit without ever
redeclaring them:

| Surface                  | Class          | Only `Card.css` supplies                             |
| ------------------------ | -------------- | ---------------------------------------------------- |
| `stats/BankrollTracker`  | `.stat-card`   | `flex-direction: column`, `gap: 8px`                 |
| `stats/StatCard`         | `.stat-card`   | `flex-direction: column`, `gap: 8px`                 |
| `SuperAgentDashboard`    | `.stat-card`   | `flex-direction: column`                             |
| `stats/PositionWinRates` | `.card-header` | `gap: 12px`                                          |
| `admin/EngineDashboard`  | `.card-header` | `gap: 12px`, `padding-bottom: 16px`, `border-bottom` |

Each of those sheets overrides `display` and their own spacing, but none sets
`flex-direction`, so today three live stat grids are laid out in a column by a
primitive nobody renders. Pull the file and they flip to a row. `Card.css` is
also pinned into the entry chunk by `scripts/ci/entry-chunk-baseline.json`,
which is what keeps the dead stylesheet shipping to every player in the first
place.

Retiring the pair properly therefore means re-homing those declarations into the
five sheets that need them, re-rendering those five surfaces, and restamping the
entry-chunk baseline. That is a CSS de-orphaning pass with five surfaces to
review, and it is honestly out of scope for a two-row console sweep. **It is not
done here, and saying so is the point.** The ruling records the exact work so
the next owner does not re-derive it.

What was explicitly **not** done: the primitive was not repainted. Putting the
console chassis on a box no player meets would have taken the count to zero
while changing nothing, which is the one outcome the row was worth avoiding.

---

## 3. The rulings have a reader

Both verdicts are claims about a tree that moves, so both are pinned by
`tests/unit/consoleInventoryIsHonest.test.ts`, which asks the scanner for its
own JSON rather than re-implementing it:

- the settlement card's stylesheet still contains nothing but zeroing
  declarations, it still scores 0, and it is still mounted **inside**
  `LeaderboardPage`'s `<SpadeConsole>` - move it out and the row re-opens;
- real paint is still counted, so the fix cannot degrade into a check that only
  ever says "fine" - measured on `AdminDashboardPage`, which the scanner's own
  `INTERNAL_ONLY` list puts permanently off the sweep, plus a tree-wide floor so
  the rule cannot survive by luck. **The control must never name a surface on
  the sweep:** the first version used `ClubAdvertisePage`, the top row at the
  time and therefore the file most likely in the whole repo to stop being
  painted, and #5083 rebuilt it mid-run. A control has to be something nobody is
  coming for;
- no file mounts anything `common/Card` exports, resolved through the barrel and
  through import bindings rather than by name, so the `StatCard` collision cannot
  produce a false pass;
- the import scan must have found its edges first - an empty scan fails loudly
  instead of reading as good news (CLAUDE.md 10.86 rule 2).

Both premises were mutation-tested before this shipped: restoring the naive
counters turns the score assertion red, and adding a single `<Card>` render site
turns the mount assertion red and names the file.

---

## The inventory, before and after

```
BEFORE                                                    AFTER
34  src/pages/ClubAdvertisePage.tsx                        33  src/pages/ClubAdvertisePage.tsx
16  src/pages/PokerArenaLandingPage.tsx                    16  src/pages/PokerArenaLandingPage.tsx
 6  src/components/common/Card.tsx                         --  ruled: nothing renders it
 3  src/components/leaderboard/LeaderboardSettlementCard    --  scores 0: it has no frame to rebuild

230 spoken for, 4 to go.                                  232 spoken for, 2 to go.
```

Then `#5083` rebuilt the Advertise page while these checks were running, so on
the merged head the inventory prints **233 spoken for, 1 to go** -
`PokerArenaLandingPage` at 16, and nothing else.

## Files

- `.claude/skills/club-arena-console/scripts/find-generic-surfaces.mjs` -
  declarations judged by value; the `Card.tsx` ruling.
- `tests/unit/consoleInventoryIsHonest.test.ts` - new, pins both premises.
- `.claude/skills/club-arena-console/SKILL.md` - 6.5 now states what the scorer
  counts.
- `docs/HANDOFF-2026-09-21-club-arena-console-sweep.md` - inventory table
  updated to what the scanner prints today.
- `docs/changelog/shots/2026-09-22-settlement-card-on-the-board-console.jpg`.

No source under `src/` changed.
