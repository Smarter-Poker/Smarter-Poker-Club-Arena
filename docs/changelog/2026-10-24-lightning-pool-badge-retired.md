# The retired Lightning pool badge is deleted, and main is green again (2026-10-24)

#7890 matched the Lightning entry to the approved cash game card and removed
the last `<LightningPoolBadge>` render; its law
(`tests/lightning/lightning-entry-cash-card.law.test.tsx`) asserts the page no
longer contains it. The component file stayed behind with nothing importing
it, so the orphan-module ratchet on `main` went from 32 to 33 and
`Client Unit Tests` failed for every pull request merged against it,
including the engine launcher repair (#7891).

The badge is retired by design, so the fix is to delete it rather than
re-import it: `src/components/lightning/LightningPoolBadge.tsx` and its
now-unused `.lightning-pool-badge*` rules in `LightningSession.css`. Nothing
else referenced either; `tests/lightning/lightning-phase-8-session-app.test.tsx`
already asserts the badge's test id is absent.

Verified: orphan ratchet, arena dollar-sign law and all 29 Lightning test
files (391 tests) pass.
