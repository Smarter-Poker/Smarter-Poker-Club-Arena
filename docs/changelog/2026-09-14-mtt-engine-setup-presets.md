# Complete MTT setup presets from engine policy

The table-config form selected a blind progression independently from its
stack and clock. Its existing Standard progression still produced a custom
50-BB, three-minute tournament unless the operator changed the other controls.
The preview disclosed those facts, but applying a coherent setup required
several unrelated selections.

An explicit Setup Preset now applies all three inputs together:

| Setup       | Initial Depth | Level Duration |
| ----------- | ------------: | -------------: |
| Regular     |        150 BB |     10 minutes |
| Deep Stack  |        300 BB |     15 minutes |
| Turbo       |        100 BB |      5 minutes |
| Hyper Turbo |         50 BB |      2 minutes |

These are Club Arena recommendations within the audit blueprint ranges.
They are not universal mandated starting stacks. PokerStars' current speed
help lists 15/10/5/2-minute tiers, while its broader tournament-types page
describes some hyper events at three minutes; exact advertised event rules
therefore remain the contract. Sources re-read September 14, 2026:
[speed help](https://www.pokerstars.com/help/articles/tournament-speed/) and
[tournament types](https://www.pokerstars.com/poker/tournaments/types/).

The engine owns the depth/clock catalogue. The preset applies depth against the
same actual opening blind used by the creation mapper, giving 3K/6K/2K/1K
starting chips at the current manual 20-chip opening big blind. Existing ramps remain
unchanged. A custom edit or restored draft stays Custom; mounting the selector
never changes it. This is an explicit new-draft action, with no booked event,
saved schedule or short heads-up satellite rewrite. Chip counts in the preview
use the existing Club Arena compact formatter.

The rendered selector is tested through the actual mapper, RPC serializer,
schedule service and engine blind validator. Cases retain bounty, satellite,
rebuy and Free Buy economics, custom overrides and SNG/cash isolation.
134 client tests across 11 discovered files and 158 engine tests across four
files pass; app/server TypeScript, focused lint and all four UI-copy gates pass.

The actual selector and preview were rendered at 393px inside the existing
console and route styles, in custom and all four selected states. No page
errors or document overflow were observed. This isolated render is not a
whole-page or production qualification. The other creation modal's preset
integration and all live acceptance remain separate. GitHub delivery is
disabled by current owner policy; no bypass was attempted.
