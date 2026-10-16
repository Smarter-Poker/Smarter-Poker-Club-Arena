# Mobile Live Table Layout And Seat Entry

Owner scope: proportional player name/stack plates and corner controls; centered waiting-list and action text; intact waiting-list-to-table/buy-in handoff; hole cards clear of boards and important totals; straight private PLO cards; a dismissible Seat Change control with an account-scoped hamburger switch; and a higher, smaller top player below Mini BBJ.

The 00:48 UTC first-party client records show a `23505` seat-number collision followed immediately by the modal's generic `BUY_IN_NOT_CONFIRMED` message. A definitive refusal now returns its actual explanation, releases the failed seat selection, and requests the current engine roster. Unknown financial outcomes keep their original durable request and receipt recovery. Explicit chair acceptance carries buy-in intent through an embedded tab move or an already-open destination, and waits for that destination's live roster before selecting an open seat. A delayed REST prefetch cannot replace an engine-owned roster.

Player plate widths and mobile heights derive from the measured table width, with readable text floors. The geometry used by viewport/chip placement follows the same dimensions. Top pods use a narrower, shorter plate. Their mobile avatar bounds align four pixels below the measured Mini BBJ frame; the desktop cap also moves up eight pixels. Private PLO rows are flat; revealed opponent rows fit their own plate width. Revealed card placement measures boards, pots, player boxes, bets, position/action labels, and bottom controls inside the owning table and chooses the nearest clear position without changing game state or canceling animations. Resize and reveal events remeasure the same layout.

The waiting-list text rows reset inherited line spacing and center their live text inside the painted face. Action controls clear inherited button padding and use an explicit amount line height. The smaller hero block gives back one pixel of reserved bottom space; landscape keeps its previous minimum felt width independently of player-plate width. The recorded geometry baseline changes intentionally reflect these requested proportions.

The artwork loading cover and button preloader were written inside a CSS string and a comment respectively. They now execute as JSX and an import. The existing artwork law parses the TypeScript syntax tree to prevent text-shaped inactive markup from passing again.

Seat Change dismissal and the ON/OFF hamburger switch share one account-scoped preference across mounted tables and browser storage events. Hiding the optional control leaves pending-move notices and waiting-list status visible.

Validation evidence and exact delivery identities are retained in the task checkpoint. Local renders are fixtures using the actual components and styles, not production or real-chip purchase evidence. This change contains no engine or database replacement.

The production cash-table certificate now measures the deployed, occupied table at 375, 393 and 430 pixels after its existing real-hand/reconnect proof, tests the actual Seat Change menu toggle, and retains mobile screenshots and measurements on successful runs. This uses the existing isolated spectator and makes no chip or seat writes. Its added read-only UI budget does not extend the causal-hand deadlines.
