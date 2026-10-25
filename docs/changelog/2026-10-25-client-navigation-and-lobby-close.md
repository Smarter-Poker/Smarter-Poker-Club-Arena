# Client navigation and Game Lobby close verification

Protected fixes #8079/#8082 retire stale UUID-to-slug lookups on route/query changes, unmount and document departure. Protected fix #8080 places Game Lobby above the ticker and retains the real ticker-component close/keyboard/focus regression. This delivery adopts those implementations without a competing runtime change.

The existing post-deploy workflow now accepts a closed client-navigation recovery request. It runs only the unchanged phone Table Management case and compact lobby rows in Chromium and WebKit, using the existing isolated account, trusted source provenance, release check and cleanup. Exact report coverage rejects skips, retries and missing or extra cases; this narrow result cannot certify the broad application suite.

Local verification retained the stale-response regression and 16 real-component card cases across portrait/landscape Chromium and WebKit. The old layer failed the close hit-target regression. Current protected regression coverage and all required publication checks remain in place.
