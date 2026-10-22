# Club Data follows Chicago midnight after refresh or suspension

The simple Club Data page could remain on yesterday after midnight: its
15-second refresh rendered `isToday = false` before the 30-second rollover
callback, replacing that callback with one that could no longer advance the
date. A tab suspended for several days also failed its yesterday-only check.

Keep the last observed Chicago calendar date in a ref and compare the selected
date against it, including when the page becomes visible. An open current-day
view follows the next Chicago date; a deliberately selected historical period
stays selected. The database continues to use its installed Chicago calendar
day facts and the existing financial rules.

The component regression reproduces the refresh-before-rollover failure,
multi-day suspension, both daylight-saving boundaries, and historical selection.
The first four cases failed before the source correction and pass afterward.

Read-only KINGS CLUB source reconciliation on October 22 at about 15:31 Chicago
matched 9,414 games (201 cash, 129 MTT, 3,098 SNG, 5,986 spins), finished MTT
net 5,997.23, running MTT net -14,094.67, cash wallet flow -72,992.69 plus
39,042.66 on the felt, tournament flow -18,029.34, and total -51,979.37.
Cash rake reconstructed before rounding was 43,377.40940112802113651536;
tournament fees were 20,483.45, totaling 63,860.86 to the cent. These are
time-specific live observations, not a reconstruction of historical seat stacks.
The screenshot's K abbreviations omit digits; exact amounts remain in the
accessible names and title attributes. No money was changed by this fix.
