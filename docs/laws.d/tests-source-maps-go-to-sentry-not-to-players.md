# tests/source-maps-go-to-sentry-not-to-players.law.test.ts

Source maps are uploaded for the bundle that SHIPS and never shipped to players: SENTRY_AUTH_TOKEN lives in the publisher and nowhere in ci.yml, the publisher strips every `.map` unconditionally and refuses to publish a survivor, and the plugin's release name is `club-arena@${VITE_APP_VERSION}` so it matches the one SentryInit.ts reports
