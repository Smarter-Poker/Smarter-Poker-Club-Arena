# Recovery requires confirmed full settlement

Recovery previously treated an accepted partial payment as enough to continue stamping prizes and completing the tournament. The existing credit helper now throws on partial or unconfirmed settlement, leaving the tournament in COMPLETING for the existing next pass. Confirmed fully paid replays still return false for newly moved chips.

Five executable cases exercise the actual recovery helper. Before the correction, three failed; after it, all five pass. This does not certify every recovery branch or production deployment.
