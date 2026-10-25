# Activate the corrected whole-game PLO5 quota

The owner's existing immediate order names the PLO5 70/30 split, cent rounding and add-on notices. The successful c3ed8648 release contains #8042 but predates #8048's whole-game quota correction. Its activation spent the old #8042 anchor before the correction passed protected checks.

Retarget the same one-time entry to protected #8048 merge bf3dc2a6c3e877dd5760b75f7ad992c33975bc4f. Keep the original validity and expiry, one-window-per-hour admission, last-hand lead, drain, freeze, certificate, proof/rollback budgets and thaw. No runtime, schedule or deployment protocol changes. Completion still requires the corrected engine identity and natural live quota, cent-receipt and notice proof.
