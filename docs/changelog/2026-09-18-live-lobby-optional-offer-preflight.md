# Live lobby optional offer preflight

The WebKit sticky-row case in production certificate 35317486463 could not click
the ALL tab because a legitimate Diamond Spins invitation covered it. The
layout measurement never ran. The production mobile spec had its own club-message
dismissal and omitted the existing optional-offer handler used by other lobby
checks.

Its original lobby entry now uses `prepareCashLobbyActions`: a delayed Diamond
Spins dialog is dismissed through its real Not Now button before the obstructed
action continues. The same helper preserves the club-message dismissal. No forced
click, hidden DOM deletion, product change, longer timeout or weaker geometry
assertion is introduced.

The existing production preflight source contract pins this caller to the shared
helper. An isolated delayed-dialog fixture exercises the original sticky-row
case in Chromium and WebKit; production acceptance still belongs to the existing
automatic certificate, with its release-identity and cleanup requirements intact.
