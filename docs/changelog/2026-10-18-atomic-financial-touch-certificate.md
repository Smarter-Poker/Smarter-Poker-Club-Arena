# Measure Current Financial Console Controls Atomically

Hosted Financial Admin verification measured three removed dashboard links as
zero-sized targets during a refresh. The retained failure snapshot already
showed the dashboard's Reading state. Its exact refresh trigger was not retained.

Select visible controls and measure their target sizes and input fonts in one
synchronous browser evaluation on the current console root. This removes the
gap between Playwright selecting visible handles and evaluating their geometry.
Keep the 44px target and 16px text requirements, pseudo-element target allowance,
and visibility semantics, including refusing visible display-contents controls
whose own target has no box. A detached console root remains an error.

The old callback fails the retained replacement regression with the same three
zero-sized labels. The repaired callback passes all five cases; the affected
four-file suite passes 13 tests. An isolated, network-blocked Chrome fixture also
passes actual visibility, replacement, pseudo-element, target-size and font-size
boundaries. No application, money, seat or timeout behavior changes.
