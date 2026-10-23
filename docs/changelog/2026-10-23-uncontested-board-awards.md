# Recorded Board Awards Survive A Fold Win

A double-board bomb hand can finish without showdown. Its recorded board payouts previously disappeared because the review and shared-hand export obtained awards only from showdown rows. Live hand #45462869 exposed this with recorded main-pot shares of 46.62 and 46.63.

The replay model now retains monetary board awards independently of card disclosure. Summary, Detail and Replay Rundown print previously unrepresented recorded awards as Pot Awards, while preserving No Showdown and hiding unrevealed opponent cards. Shared hands retain the same recorded slices. Existing showdown rows keep their awards without duplication, and legacy records acquire no invented allocations.

This is a client-only followup using the already deployed recording contract. Payouts, fees, cards, engine behavior and database records are unchanged. Focused regressions reproduce the missing awards before the repair and cover real review components, share roundtrip, high/low, zero slices and legacy absence. Production verification remains a separate delivery gate.
