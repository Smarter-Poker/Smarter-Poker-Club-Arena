# tests/lightning/lightning-mode-switch-dwell.law.test.ts

A Lightning game stays in its mode long enough to play it (Lightning transition phase 5, 2026-10-26): the ON condition must hold 60 s before pending_on, the OFF wait defaults to 120 s, and no automatic switch comes within 15 minutes of the last automatic one; always_on games, operator doors and drains, a disabled game and Lightning switched off are never held.
