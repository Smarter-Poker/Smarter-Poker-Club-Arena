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

The required CSS browser job exhausted its 30-minute budget fetching Ubuntu
packages from the hosted image's Azure mirror before any tests ran. That job
now selects Ubuntu's primary HTTPS archive before the unchanged Chromium and
WebKit installer. Fixture tests cover both APT source formats, unchanged signing
keys and other repositories, idempotence, and refusal of absent sources. Browser
versions, test assertions and job limits remain unchanged.

The PostgreSQL installer encountered the same mirror stall: one runner spent
18m35s installing packages while three identical successful runners took
26-38 seconds, exhausting the job during passing native tests. A targeted retry
passed with a 30-second install, but integration qualification encountered the
stall again. Apply the same tested mirror selection before the existing isolated
Ubuntu/PGDG source copy. Keep package versions, signature verification, all native
cases and job limits intact.
