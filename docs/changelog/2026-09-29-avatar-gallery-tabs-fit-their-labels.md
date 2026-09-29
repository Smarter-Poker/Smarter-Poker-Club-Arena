# 2026-09-29 - The avatar gallery's tabs fit their labels

Found on the Android emulator during the store-readiness walkthrough, on a
393px-wide phone: in the Avatar Gallery, "PRESETS (25)" ran into "VIP (72)".

The tab bar split its width into four equal columns
(`repeat(4, minmax(74px, 1fr))`) and every label is `white-space: nowrap`,
so a label wider than a quarter of the bar spilled into its neighbour.
Measured in the app with a Range over each label, PRESETS' glyphs ended at
x=119 inside a tab that ended at x=99.

Each column is now at least as wide as its label
(`repeat(4, minmax(max-content, 1fr))`); spare width is still shared equally.
Applied to the running app on the emulator first, the tabs measured 124, 89,
89 and 89, no label overflowed, and the bar still fit the screen. A screen too
narrow for all four scrolls the bar sideways, as it already could
(`overflow-x: auto`), instead of printing one label over another.

`tests/unit/avatarGalleryTabsFitTheirLabels.test.ts` holds the bar to it:
content-sized columns, nowrap labels with a scrolling bar, and no other rule
for the bar that puts a fixed-width column back. Without the change, two of
its three cases fail.
