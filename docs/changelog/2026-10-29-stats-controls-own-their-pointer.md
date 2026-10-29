# Stats controls keep their own pointer activation

The real Stats pane attaches useSwipeTabs around the Downline ledger. Its
unconditional parent pointer capture retargeted the pointerup/click away from
Show More, so the button stayed active but never changed rowLimit or sent the
1001-member read. The isolated browser fixture previously omitted that hook;
adding it reproduced the exact production failure: 621 rows expected, 501 received.

The maintained hook now leaves descendant native and ARIA controls, editable
content and their nested children with their own pointer. It clears stale swipe
coordinates before returning. Ordinary pane content still captures its pointer
and changes tabs on a horizontal swipe; interactive ancestors outside the pane
are not treated as descendant controls. No click handler, keyboard path,
animation, financial operation or timing assertion is bypassed.

The same real-hook browser fixture passes with the source repair for both mouse
click and touchscreen tap. It retains 500-member expansion, initial 300ms debounce
retention and 299+1 search reset. Unit behavior checks cover descendant controls,
nested targets, stale gesture reset, ancestor containment and preserved swipes.
The production proof and exact three-read/write-guard contract remain unchanged.
