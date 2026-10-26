# Slug Lookups Stop At Document Departure

Route cleanup retires stale SPA lookups, but an outgoing document remains
mounted while its next document request is pending. A delayed canonical slug
redirect could still interfere with that request. SlugEnforcer now also
retires its lookup on beforeunload and removes that listener on cleanup.
It never prevents or delays departure and preserves the existing redirects.

The real component's native departure regression fails against the route-only
repair and passes with this addition. Controlled Chromium evidence with the
real component and BrowserRouter confirms beforeunload precedes the pending
request; a delayed old lookup canonicalizes the old URL while that request is
pending, and the departure fence prevents that interference. The controlled
ordering does not reproduce production's exact net::ERR_ABORTED error code.
