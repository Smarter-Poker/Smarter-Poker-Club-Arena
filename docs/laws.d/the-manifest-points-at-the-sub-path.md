# tests/the-manifest-points-at-the-sub-path.law.test.ts

public/manifest.json shipped verbatim with start_url "/" and scope "/", so a
player who installed the arena as a PWA from smarter.poker/hub/club-arena got
an app that opened the World Hub root and claimed the whole origin, and the
icon path was the web sub-path even in the native shell. Vite rewrites paths
in HTML and CSS, not JSON. scripts/stamp-manifest-base.mjs rewrites the built
copy from the build's base after vite build on both targets. This law pins
the stamp for the web and native bases and its place in build:ci.
