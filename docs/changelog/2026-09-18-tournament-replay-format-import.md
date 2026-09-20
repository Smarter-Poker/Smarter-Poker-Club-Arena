# Load tournament replay routing with its action

The unlimited-format client added a static presentation import to the
app-root tournament result host. Production Build 105441650882 correctly
refused the newly eager module before first paint. The host only calls those
helpers after the player selects Play Again.

That action now imports the same module inside its existing asynchronous
try/catch. Missing chunks retain the existing reported-error/list fallback and
busy-state cleanup. The synchronous presentation APIs, recorded-format rules,
fixed SNG/Spin/legacy HU routing and unknown-format refusal are unchanged.
The ticker and tournament pages already load lazily.

The existing entry-bundle regression now covers the action boundary. No entry
baseline or size limit changed. The owning task verified 25 affected tests,
the app compiler and the actual production build. The entry check passed at
150 kB gzip with no newly eager modules. That local bundle is not published;
current-main integration, protected checks and compatible engine/ABI adoption
remain required before release.
