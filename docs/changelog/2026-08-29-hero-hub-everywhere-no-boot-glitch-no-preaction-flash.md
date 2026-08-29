# 2026-08-29 — Hero Hub On Every Avatar Tap, No Boot Glitch-Reload, No Pre-Action Panel Flash

Three of Dan's reports from 2026-08-29, one commit. (This commit also carries
the mobile felt-insets work swept in by the shared clone's auto-committer —
see `2026-08-29-the-notch-the-harness-could-not-see.md` for that half.)

## 1. The tabbed Hero Hub opens from YOUR avatar on every page, every variant

Dan: "THE ACTION BAR THAT POPS UP WHEN YOU CLICK ON YOUR OWN AVATAR NEEDS TO
BE ... THIS ONE SPECIFICALLY ON EVERY SINGLE PAGE INSIDE THE CLUB ARENA
REGUARDLESS OF WHAT KIND OF GAME YOU ARE PLAYING." Some sessions saw only the
throwable-only Send Reaction modal — no Stats / Profile / Table tabs.

Root cause (`TablePage.tsx`, seat render): `onAvatarClick` decided hero vs
villain by `player?.isHero`, but the seat RENDERS `displayPlayer`, which
synthesizes a hero placeholder while the hero is pending / waiting to be
dealt in. In that whole window `player` is null, so tapping your own avatar
took the villain branch and opened the throwable-only selector. Fixed to
read `displayPlayer?.isHero`, with `displayPlayer?.id === userId` as the
backstop for snapshot rebuilds that drop the isHero stamp. MultiTablePage
embeds TablePage, so this is every live surface.

## 2. The open-from-Hub / first-login glitch-reload

Dan: "IT LIKE GLITCHES AND RELOADS... IT LOOKS LIKE BROKEN CODE."

Mechanism: the SW serves the shell cache-first, so every entry after a deploy
(most entries, at our cadence) booted the one-deploy-old shell; seconds later
SHELL_UPDATED / controllerchange armed `useShellUpdateGate` and the page
hard-reloaded after paint. Three changes:

- `public/sw-bus.js`: the revalidation fetch (already on the wire every
  navigation) gets a bounded budget (`SHELL_FRESH_RACE_MS` = 300ms) to answer
  BEFORE the cached shell is returned. Network wins → the session boots the
  CURRENT shell and there is nothing to reload. Budget expires → cached
  shell instantly, exactly as before. Not the 2026-08-24 network-first
  regression: no added requests, 300ms cap, offline costs ~0ms.
- `useShellUpdateGate`: SHELL_UPDATED and controllerchange no longer arm the
  reload blindly — `verifyThenArm` compares the running entry chunk to the
  deployed one first, so a session already executing the current bundle is
  never rebooted (both events fire in exactly that situation now).
- A genuinely-stale boot that still must reload does it inside the startup
  window (`settleDelayMs`: 0ms during the first 15s, 3s settle after), so it
  reads as part of loading, not a post-paint glitch. All existing guards
  (never at a table, never hidden, cooldown) unchanged.

Pinned: `tests/unit/shellUpdateGate.test.ts`, `tests/unit/swBootLatency.test.ts`
(both updated in this same commit, per the update-the-pin-with-the-change rule).

## 3. Pre-select executes without flashing the action panel

Dan: "IT CURRENTLY 'EXECUTES THE CHOICE' BUT THEN IT 'FLASHES THE ACTION TAB
BACK UP' BEFORE IT CLOSES IT AGAIN."

Pre-actions are engine-executed (Bible V8 §4.15). Between the snapshot that
hands the hero the turn and the snapshot carrying the engine's auto-action
there is one round trip — the ActionPanel mounted for exactly that gap.

New `src/lib/preActionPanelGate.ts` (pure, unit-tested): the panel stays down
while the armed pre-action is one the engine can honor right now (fold /
Call Any always; Check only with nothing to call; Call N only while the
price fits the armed cap — the client half of the engine's own refusal
rule). A `PRE_ACTION_EXEC_GRACE_MS` (2.5s) failsafe brings the panel up if
the engine does not act, so suppression can never cost the player their
turn. Pinned: `tests/unit/preActionPanelGate.test.ts`.

## Verification

`npx tsc --noEmit` clean; targeted suites green (preActionPanelGate 6,
swBootLatency 12, shellUpdateGate 14, animations-always-play 24,
no-auto-table-switch 5, handCompletionLaw 18). Full suite runs on the PR's
required checks.
