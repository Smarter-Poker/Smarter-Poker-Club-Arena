# Plus pages remain open and the lobby restores its game family

Scope: client navigation only. Pages opened through + must remain on their current page until manually closed. Returning to a club lobby restores the saved Cash Games or Tournaments view and its existing saved filters/sort.

Removed HubFrame's timed background unload. Reopening an existing lobby tab now focuses its current page without clearing its history. A TABLE_SEATED event adds a table without replacing the lobby. Lobby preference hydration opens the family containing the saved game type.

Checkpoint: owned branch fix/plus-lobby-persistence-20261030, base f98e3e50c4. Policy 2.9 read 2026-10-31T00:21:41Z, canonical manifest a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b. Canonical four policies, storage guide, root instructions, playbook, publishing and deploy paths read. Required checks/publication/live verification pending.

Additional root cause: the seat-rebuild callback re-applied ca_last_active_table after every seat refresh. It now refuses to restore table focus over a visible page. Opening either lobby family records the selected type even when its current type already matches (including the ALL cash view). Explicit named-list requests still clear drill-in history at that user navigation only.

Focused mounted-frame and navigation/source regressions: 60 passed. TypeScript noEmit passed before final formatting; final build/full suite in progress. Provider secret-name metadata verified through the configured keyring identity; no secret values accessed.

Validation update: final focused checks (page retention, preference hydration, production preference-proof helpers and coverage) passed 45/45. Mounted HubFrame/browser-tab checks passed 60/60. `tsc --noEmit` passed. First broad local suite was interrupted after moving its temporary directory invalidated its running fixtures; it is not passing evidence. The replacement full suite uses an external scratch directory with four workers. Production cold-return browser proof now asserts the saved section is already expanded before any click and chooses the opposite game family.

Final validation policy reread: canonical four files emitted 2026-10-31T00:26:36.913Z, policy 2.9, unchanged manifest a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b. Initial normal push refused outdated reset/remount/collapsed-lobby test contracts, which are updated to the October 30 owner direction; no bypass used. The 90 connected navigation and mounted-lobby tests now pass, including late remote family restoration before interaction and preservation after an explicit local choice. Build passed. Protected delivery and production readback remain pending.
