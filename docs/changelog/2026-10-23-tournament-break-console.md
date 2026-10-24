# Tournament Break Console

The tournament break card stacked unrelated sliced frames, painted an opaque page background, and let its content outgrow the popup's height cap. Its lower standings could disappear behind a clipped closing rail.

The card now uses one approved SpadeConsole with a complete fixed head and foot and a scrollable glass interior. A large gold countdown and compact next-level blinds lead into field statistics, the player's position and five ranked leaders. Event names wrap, usernames retain their spelling, and compact chip figures round down with exact values in their titles. The transparent outer layer keeps the table and lobby accessible. The attached X collapses the card to a keyboard-operable clock; Escape also collapses it. The popup and collapsed clock honor the global footer clearance so navigation never covers their controls.

The existing server clock and last-hand/countdown phases remain authoritative. Zero seconds reports Waiting For Play To Resume rather than claiming gameplay restarted. Pending and failed tournament reads show loading/unavailable state instead of fabricated zero statistics. No engine, database, financial or break-scheduling behavior changes.

Regression coverage exercises delayed clock ticks, last-hand transition, zero-time waiting, minimize/reopen, field/hero values, pending/failed/empty reads and the single-frame scroll contract. Real-font Chromium renders check phone, desktop and short landscape layouts, long titles, standings access and keyboard reopening. Publication evidence belongs in the task checkpoint, separately from these local checks.
