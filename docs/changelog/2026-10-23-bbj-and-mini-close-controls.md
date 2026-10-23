# Matching Close Controls For BBJ And Mini BBJ

The table's BBJ and Mini BBJ banners now have matching silver X buttons. Each hides its own banner for that mounted table view; reopening the view restores the banners. Routine amount updates do not undo dismissal. Jackpot eligibility, feeds, amounts and hit celebrations are unchanged.

The details action and close control are sibling native buttons, so clicking or keyboard-activating an X cannot also open jackpot details. The existing mini keyboard contract now checks its native button instead of requiring a custom keydown handler. Behavioral tests cover Enter/Space, independent dismissal, continuing details access, positive-mini eligibility, remounting and celebrations after dismissal.

The existing plate geometry reserves space for the X; the smallest phone layout tightens label tracking and the inner gap to retain a full seven-digit amount. Verified in a real browser at 320px and 393px, with the existing global stylesheet.

This is a client-only presentation change, with no engine activation or database migration dependency. Release and live verification evidence is retained in the task checkpoint.
