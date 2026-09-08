# Partial Settlement Remains A Financial Incident

F44: the common tournament settlement helper returned immediately for ok=true, even when its validated receipt recorded unpaid debt. Such partial payments bypassed the financial-alert path used for refusals.

The original helper now awaits the existing server financial alert for a positive validated remainder. Context includes the recorded owed, paid and remaining amounts, obligation identity, player, event and a stable dedupe key. Payment is not retried and the receipt is unchanged. Invalid receipts do not produce guessed unpaid amounts; full replay produces no debt alert.

Three partial/replay cases failed against the baseline; all five cases now pass. The related settlement suite passes 24 tests. Server TypeScript and the full local server suite pass: 6,641 tests across 470 files.

The existing alert service never throws and retains its existing persistence/throttling escalation. Live delivery to management is not certified by these mocked boundary tests. No live notification, wallet adjustment, new recovery path or forced restart was performed during verification.
