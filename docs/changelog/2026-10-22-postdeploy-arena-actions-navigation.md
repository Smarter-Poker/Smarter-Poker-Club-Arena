# Post-deploy club entry follows the approved Arena actions

The deployed route sweep waited for the retired bottom `Quick actions`
navigation while checking club-card clearance. The approved page now renders
the top `Poker Arena Actions` navigation, so the old target timed out even
though the active club card and the new actions were visible.

The existing production test now measures the rendered Arena actions. It
retains the two-direction overlap check, the same deadlines, the actual card
click, and the club-detail route assertion. No application behavior or engine
contract changes.
