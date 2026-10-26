# Add-on notices stay inside their table

A natural live 3.60 add-on at a right-edge PLO5 seat displayed the correct notice, but the 375px screenshot clipped its amount beyond the screen. The shared bubble centered itself on every seat without considering the available table pane. Its notice text also forced every amount onto one line.

The original bubble now measures its own table pane when mounted and resized, shifts only enough to keep the bubble inside that pane, and keeps its pointer aimed toward the same seat. Notice text wraps without removing cents. Existing artwork, content, ownership, delivery, lifetime and entrance animation remain unchanged. No financial or engine behavior changes.

Two actual-browser regressions in the existing table-proportions gate fail on the old component, then pass on the correction. They measure both edges at 375px and 393px, retain the complete 1,234,567.89 amount, and resize into an offset 240px multi-table pane. Focused chat/add-on behavior checks and TypeScript also pass. Publication and the final natural live notice proof remain separate delivery evidence.
