# Restore the selected cash witness's lobby tab

Post-deploy run 40236568490 discovered an occupied NLH cash table, scanned onward to the empty LIMIT tab, and then failed the unchanged read-only View action assertion. Discovery now retains each contender's lobby tab through the common health refresh. Navigation restores the tab of the actual next-hand progression winner and waits for that exact row/card before opening its details or asserting its read-only action. The winner can differ from the first contender.

Executable regressions reproduce the old failure for NLH and later PLO winners in card and compact layouts, and check that discovery preserves tab provenance. The existing progression, visibility, spectator-only navigation, silence limit and case deadlines remain mandatory.
