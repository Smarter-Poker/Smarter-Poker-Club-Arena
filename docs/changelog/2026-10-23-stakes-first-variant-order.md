# Stakes sorting groups each price before its game variants

High To Low and Low To High now order cash games by numeric stakes first, then canonical variant order at the same price: PLO, PLO5, PLO6, PLO8. The page and shared desktop/compact lobby renderer agree. Previously variant grouping took priority and split each stakes level across the list.

Empty games still follow populated peers within their stakes and variant group. Other sort headings retain their existing variant grouping. Saved stakes choices use the corrected order on remount.

The rendered-menu regression covers both directions, desktop and compact controls, PLO through PLO8, saved state, and an empty game at a stake boundary. The regression failed against the previous comparator before the repair.
