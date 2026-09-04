# tests/the-lobby-always-has-its-footer.law.test.ts

The footer belongs to the lobby, not to a URL (Dan 2026-09-04): the in-table "+" opens the club lobby as a tab on /table/<id>, so the app-root footer gate reads the route OR the multi-table container's "active tab is a lobby" signal (inTabLobbySurface); a lobby tab parked behind a live table publishes false, so the footer never floats over a felt
