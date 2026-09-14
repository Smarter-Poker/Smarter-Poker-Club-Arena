# Game rules, on the shark frame

2026-09-14. Branch `feat/felt-buy-in`, fifth commit. Eighth surface of the
felt sweep.

`GameRulesModal` - the table's rules sheet, four tabs deep - was the generic
metallic chassis: an info glyph, a close glyph, four tab buttons, boxed
readouts, chip-shaped feature tags, boxed rules. A page of content with one
action, so it wears the shark frame, whose single plate reads Close.

## What prints where

- Eyebrow Cash Game Rules or Table Rules, the variant as the title, the
  stakes as the pill in lit blue. The dialog is named `<variant> Rules` for
  a screen reader, as its heading used to read.
- Table Info, Rules, Betting Limits and Hand Ranking as four lit words, the
  live one in white. The words keep their own active-class expressions: the
  bomb-pot guard anchors on `activeTab === 'info' ? 'rules-modal__tab--active'`
  to prove the Table Info tab can be opened, and it still can.
- Financials, Bomb Pot and the custom house rules as rows on the glass
  under a lit label; the table features as words, lit green when the table
  plays them, muted when it does not; Bomb Pot Next Hand and Edit Bomb Pot
  Settings as lit words for staff, gated as before.
- The rules, the limits and the cash button and blinds as copy, one
  sentence to a line with an engraved rule between; the pot-limit worked
  example as a callout on a blue rule.
- The hand ranking as before: name, the five card images, the line under.
- Close on the plate. The scrim still closes.

## The content scrolls, the plate does not

The content area is the one part that scrolls, capped to what the viewport
leaves after the head, the tabs and the foot, so at 393 by 852 the Close
plate is on screen from the first frame in every tab and the copy scrolls
under the frame.

## Re-rendered, not rewritten

Every sentence, every row and every gate is as it was; the stylesheet was
rewritten under the same class names. `classNamesResolve`'s baseline drops
41 to 35: `rules-modal__section` was five of its unresolved names and the
new sheet defines it.

## Verification

Rendered at 393 by 852 in five states - the NLH rules, the NLH table info
with bomb pot rules and both staff words, the PLO8 betting limits, the
Short Deck hand ranking, a tournament Pot Limit Omaha with no bomb pot -
beside the old component, and the table info at a 1000px viewport at the
560px cap. The plate label sits inside its face; the variant and the stakes
fit their zones. Copy gates and no-emoji OK; the covering suites pass.
