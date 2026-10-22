# Post-Deploy Browser Failures And The Once-Daily Engine Reset In Agent Docs

Date: 2026-10-21

## Browser Failures (Post-Deploy E2E run 39677240619, Client browser verification)

- **Navigation (hamburger menu).** `getByRole('heading', { name: 'Play' })` matched
  both the drawer section header and the lobby's Diamond Arena "Play" zone heading
  (strict mode violation). The assertions are now scoped to the drawer dialog
  (`Poker Arena`) with exact names. Behavior checked is unchanged.
- **Member pages.** Shark Club was rebranded to Kings Club on 2026-10-21 and the
  legacy `clubs/shark-club` path now redirects to `clubs/kings-club`, so the
  player-record URL assertions failed. The spec uses the canonical slug. The manual
  roster Refresh button was intentionally removed in #7600 (the roster syncs live),
  so the required-control list no longer demands `.members-refresh` and the 44px
  touch-floor check measures the Sort Players control instead.
- **Mobile-WebKit gestures.** `mouse.wheel` is rejected in mobile emulation. The
  lobby filter-lock test keeps the real wheel where supported and otherwise issues
  the same upward user scroll with `window.scrollBy`, which reaches
  `useHideLobbyFiltersOnScroll` through the identical document scroll event.
- **Permissions (home page).** `get_club_players_playing(text)` read
  `SELECT * FROM public.clubs` as SECURITY INVOKER after clubs adopted
  column-level privacy, raising `permission denied for table clubs` for signed-in
  players (1,842 errors in the afternoon). The function now reads only
  `id, union_id, asset`. Applied as `20261021222550`; this change records the
  byte-exact migration file so the ledger reconciles.

## Agent Instructions

CLAUDE.md, AGENTS.md, AGENT-PLAYBOOK.md, PUBLISHING.md, AGENTS-PUSH-GUIDE.md,
.github/DEPLOYMENT.md, .agent/workflows/deploy-troubleshooting.md,
docs/HANDOFF_CURRENT_STATE.md and .env.example now state that the engine resets
once a day at 04:00 America/Chicago, with no hourly engine reset or cash-game
freeze. The 4 AM schedule itself is unchanged.

## Follow-Up: Synchronized Tournament Break In The Live-Table Lane

With the engine resetting once a day, the hourly platform freeze no longer
masks the hourly synchronized tournament break at :55. Post-deploy run
39694814807 failed the MTT live-table case at 45 s of silence because table
0260b54a had parked for its tournament's 23:55Z break. The case now classifies
a silence inside the persisted `break_started_at` / `break_ends_at` window as
an authoritative hold (reselecting another board within the same deadline),
with the same before-break and after-break silence limits as the add-on hold.
Pinned by `tests/unit/synchronizedBreakHold.test.ts`.

## Follow-Up: Agent Assignment Proof Respects The Union Commission Band

With the agent-row index live (#7647) the isolated identity got further and
then failed in `qualify-agent-assignment.mjs`: its earning test agents were
inserted with `commission_rate: 0`, which `fn_enforce_agent_commission_bounds`
refuses now that the certification club's union band is 0.20 to 0.70
(03:05:48Z). That failure skipped the template staff fixture, so table
management and club news failed behind it. The proof now reads the club's
union band and uses its minimum (inert: these identities never play).
