# Players Tab Casino Realism Final Sweep, 2026-09-06

## Scope

Routes:

- `/clubs/:clubId/members`
- `/clubs/:clubId/members/:userId`
- `/clubs/:clubId/members/:userId/statistics`
- The cashier transfer dialog reached from player-role management

This sweep follows the Phase 6 recertification. It changes presentation,
accessibility, route-state handling, and client navigation only. It does not add
or remove a member, change a club bank, move chips, fund an agent, or alter any
player record.

## What The Final Audit Found

- The roster command page already had its own optimized photographic desk, but
  the player record and performance pages were generic stacked cards with no
  distinct visual identity.
- Missing route parameters on either detail page returned before `finally` could
  settle the first loading state, leaving an endless skeleton.
- Downline rows displayed player records but were not actionable, even though
  every row had a valid member destination.
- The cashier dialog used generic global selectors including `.form-group`,
  `.message`, and `.close-btn`. Those rules remained active after the lazy chunk
  loaded and could restyle unrelated Club Arena components.
- The cashier did not lock background scrolling, trap keyboard focus, or return
  focus to the control that opened it.
- The bulk-selection controls were 34 pixels tall and several roster popup and
  bulk controls had no explicit focus ring.
- Existing `text-transform: uppercase` rules overrode the Title Case stored in
  the interface copy.

## Design Direction

Palette: Obsidian `#05070a`, Carbon `#0d1218`, Steel `#566575`, Arena Cyan
`#00d4ff`, Brass `#ffc93c`, and Alert Red `#ff5a67`. Rajdhani carries display
and numerical readouts; Roboto Condensed carries operational labels; Inter
carries forms and supporting copy.

The three Players destinations now use different physical compositions:

- Roster: the existing club personnel ledger desk.
- Player Record: a macro black-anodized credential plate seated in a brass
  verification slot with a restrained cyan inspection lamp.
- Player Performance: an overhead midnight felt and leather instrument surface
  with brass calibration arcs and cyan measurement points.

The player record uses a cinematic credential followed by a two-column audited
ledger. The performance page uses a felt instrument hero, three immediate
readouts, one control console, and three distinct measurement bays. The cashier
is a compact carbon and brass console rather than a glass card.

## Graphics

Both new graphics were generated with the built-in image generator in standard
mode, then converted to optimized WebP assets:

- `public/images/club-members/member-credential-v1.webp`
- `public/images/club-members/player-instrument-felt-v1.webp`

Credential prompt direction: cinematic macro product photograph of a black
anodized membership plaque seated in a brass verification slot, cyan inspection
lamp, deep negative space at left, no cards, chips, text, logo, or people.

Instrument prompt direction: cinematic overhead product photograph of midnight
felt, black leather, brass calibration arcs, and restrained cyan measurement
points, deep negative space at left, no cards, chips, text, logo, or people.

## Functional And Accessibility Changes

- Missing or malformed route state now resolves to `Member Not Found` instead
  of an endless loading surface.
- Downline rows are real buttons and open the selected player's record.
- Player identity, live presence, player number, notes, provenance, activity,
  wallets, downline, role authority, Promo Vault, and statistics remain backed
  by the existing server capabilities and reads.
- The performance hero readouts use the same verified statistics response as
  the detailed bays. No number is invented or separately calculated.
- All changed controls meet a 44-pixel minimum target, expose a visible focus
  state, and retain native date and select behavior.
- The cashier traps Tab and Shift+Tab, supports Escape, locks page scrolling,
  restores the opener, and clears its delayed close timer on unmount.
- Cashier selectors are rooted to `.chip-transfer-modal`, eliminating the
  cross-page CSS leak.
- Title Case is preserved visually, including controls, labels, popup copy, and
  state messages. U+2014 punctuation is absent from the Players source and
  styles.
- Reduced-motion rules cover all three pages and the cashier dialog.

## Verification

The pre-publish verification gate covered the complete Players route map and
the shared cashier popup:

- The Phase 6 regression baseline passed 131 of 131 focused tests.
- The Players UI, cashier, privacy, role, credit-line, promotion, global-style,
  and no-hover checks passed after the final fixes.
- The default full-suite run completed 14,568 assertions. Its remaining 14
  results were five-second scanner timeouts under local parallel load, not
  assertion failures. Every affected scanner was rerun serially with an
  extended timeout and passed 73 of 73 assertions.
- TypeScript compilation, the Title Case law, the painted-text law, and the
  production Vite build passed.
- ESLint reported zero errors. Existing repository warnings remain warnings and
  do not block the build.

The release commit is rebuilt after rebasing onto the newest `origin/main`.
Production publication and live build provenance are verified separately as
the final delivery gate.
