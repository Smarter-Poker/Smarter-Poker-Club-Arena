# 2026-08-28 — Round 5: pre-action money bug, hero hub, HUD sizing, ticker toggle

Agent: cowork-mobile. Branch: `agent/cowork-mobile/fix/round5-preaction-avatar-panel`.

1. **CRITICAL — "Call 15" can never call a raise (Dan, verbatim: "THAT CAN
   NEVER EVER EVER HAPPEN").** Root cause: PreActionEngine's only cap on
   `auto_call` was the optional client-sent `maxCallAmount`, and the client
   NEVER sent it — so `auto_call` was byte-for-byte `auto_call_any`. Three
   independent fixes: (a) the engine now records `toCallAtSet` from its own
   authoritative state at arm time and refuses to fire an `auto_call` whose
   price rose past it (server-side, immune to any client version); (b) the
   client snapshots the price on the pressed button and sends it as the cap;
   (c) PreActionBar disarms the lit toggle on screen the moment the price
   rises. Server test that pinned the bug as a requirement inverted; new
   suites added both sides.
2. **Pre-actions re-appearing after executing.** Three defects: the server's
   2026-08-21 "sticky" re-arm (check-family pre-actions silently re-queued
   after running — deleted; every pre-action is single-shot now); the
   client's arm/clear "retries" never retried (serverSetPreAction never
   throws, so retryAsync resolved the first `{success:false}` — falsy results
   are now thrown as retryable); and the failed-clear restore was dead code
   (`const armed = preAction` inside the branch where preAction is null —
   now reads `lastArmedPreActionRef`).
3. **Hero hub.** New `HeroHubPanel` (tabs: Throwables / Stats / Profile /
   Table) opens from the hero's own avatar. Throwables renders the existing
   ThrowableSelector leaf inline; the other tabs launch the existing
   surfaces (RealTimeResultPanel / TournamentInfoPanel, ClubProfileModal,
   avatar gallery, IdentityModal, SettingsPanel). The upper-left cash stats
   button (MiniStatsCard icon) is removed on mobile AND desktop; the
   tournament variants stay (spectators have no hero avatar and need the
   TournamentInfoPanel route).
4. **Hamburger fills its slot.** The icon-hamburger webp carried ~20%
   transparent canvas margin — re-cropped to its art bounds in storage (both
   colors); the tab-bar trigger grows 32→34px on phones (full pill height),
   paid from the documented 375px budget slack.
5. **Prev-hand + rabbit hunt = chat size.** `--sp-hud-tile-size` 36→44px,
   radius 10→12 (chat button parity at every breakpoint; the token moves all
   three bottom-left tiles together by design). Budget: 44+8=52 under the
   68px `--sp-hero-clear`. Pinning test updated.
6. **Ticker toggle.** New `showTicker` setting (default ON) with a toggle in
   the in-table Settings panel (Display) and the Club Arena /settings page;
   consumed by TournamentStartingTicker (the scrolling .mtt-ticker), synced
   live through the shared store + SETTINGS_CHANGED bus, and bridged both
   directions in settingsBridge.

Verification: client+server `tsc --noEmit` clean; client 8,273 tests green
(incl. new price-rise disarm + requireStamp suites); server 2,204 green
(incl. new PreActionEngine suites); `npm run build` ✓.
