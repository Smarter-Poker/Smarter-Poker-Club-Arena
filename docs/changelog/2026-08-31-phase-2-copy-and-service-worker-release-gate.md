# Phase 2 release gate: every visible word is cased and the local service worker controls the front door

## What the audit found

The existing title-case check covered plain JSX text but missed copy rendered
through accessibility attributes, direct JSX expressions, template fragments,
page metadata, and presentation props such as `label`, `description`, and
`tooltip`. It also followed conventional title-case rules that left joining
words lowercase, which did not match the explicit Club Arena rule that every
prose word starts with a capital.

The UI dash check did not inspect `index.html`, so page metadata and the fatal
boot fallback could bypass the no-em-dash rule.

An isolated browser smoke run also found that local Vite responses did not
send the `Service-Worker-Allowed` header used in production. Chromium rejected
the intentionally slashless Club Arena scope, logged an error, and then fell
back to the narrower worker scope.

## What changed

- The shared `titleCase` helper now capitalizes every prose word while
  preserving acronyms, ordinals, numeric units, plural suffixes, URLs, email
  addresses, route examples, and machine keys.
- The static title-case gate now covers JSX text, rendered expression strings,
  nested template fragments, visual and accessibility attributes, common
  presentation props, metadata, and the boot fallback.
- The dash gate now covers `index.html` in addition to application UI source.
- Existing forward-facing copy and matching test selectors were normalized to
  the enforced rule.
- Local Vite serving now mirrors production's slashless Club Arena service
  worker scope header.
- The post-build optimizer no longer forces the lobby route into every initial
  page load. Deep links such as Leaderboards keep HomePage lazy, removing about
  16 kB gzipped from their initial download and restoring cross-platform bundle
  budget headroom.

## Verification

- `scripts/ci/all-gates.sh`: passed, including type safety, 10,484 tests,
  production build, and bundle-size enforcement.
- ESLint: zero errors; the repository's 653 pre-existing warnings remain.
- Isolated Chromium smoke: critical routes loaded in 318 to 963 ms and the
  console-error check passed with the expected test environment.
- Table Studio browser suite: 4 of 4 flows passed, including commerce,
  persistence, realtime, accessibility, keyboard, zoom, forced colors, and
  visual comparisons.
