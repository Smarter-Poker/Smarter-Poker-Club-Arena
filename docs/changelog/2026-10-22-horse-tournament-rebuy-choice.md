# Horses choose whether to rebuy after busting

Owner direction: 45% of horses rebuy when they bust a tournament; the others stay out. The tournament horse input device previously submitted every eligible horse to the purchase transaction.

The input choice now uses a uniform SHA-256 draw below 0.45, keyed by tournament, horse and the recorded busting hand. Repeated sweeps and replacement managers keep the same decision. A later bust gets a new draw. Declining horses request no purchase and wait out the existing database-owned decision window before normal elimination. An unreadable bust identity stays unresolved rather than charging or declaring a decline.

Existing Free Buy allowances, rebuy/re-entry products, windows, maintenance guards and atomic pricing/funding/cap/duplicate protections remain in force. Human decisions and cash-game rebuys are unchanged. No database migration or financial backfill.

Regression evidence: the real manager test produced 20 purchase calls before the change versus the expected 8 willing horses in a fixed 20-horse sample. The changed path returns the other 12 as answered declines. Focused policy and manager tests cover per-bust stability, field distribution, unknown identity, restart/retry, closed windows, maintenance and ambiguous purchase outcomes. Source merge is not proof of live engine activation; routine deployment follows the existing daily 04:00 Chicago route.

Hosted accounting qualification exposed a pre-existing midnight fixture failure. The protected correction subsequently merged into main and is retained unchanged here. No production report implementation or installed database changed.
