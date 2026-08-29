# 2026-08-29 — Hardening Pass: The Morning's Three Fixes Made Permanent

Follow-up to `2026-08-29-hero-hub-everywhere-no-boot-glitch-no-preaction-flash.md`.
That commit fixed Dan's three reports; this one makes each fix impossible to
lose, measurable, and closes the holes found while shipping it.

## 1. The avatar rule is now a law

`src/lib/heroSeatTap.ts` — `seatTapTarget(displayPlayer, userId)` is the one
place that decides hero-hub vs villain-throwables, and
`tests/hero-avatar-opens-hero-hub.law.test.ts` pins both the rule (placeholder
window, dropped isHero stamp, villains, guests) and the wiring (TablePage must
route the tap through it, and no tap handler may read the raw snapshot
player's hero flag again).

## 2. The pre-action disarm cannot unmount any more

PreActionBar's clearing effects die at the exact boundary they exist for —
the bar unmounts when the turn arrives, which is when a raise invalidates an
armed Call. The same honorability rule now ALSO runs at page level in
TablePage (idempotent with the bar's copy), pinned in
`tests/unit/preActionPanelGate.test.ts`.

## 3. The engine/client pre-action timing contract is pinned cross-repo

Considered and REJECTED: executing an honorable pre-action inline at turn
advance (it would undo Dan's 2026-08-20 "a pre-action is still an ACTION and
must be seen" visible beat), and broadcasting a "will auto-act" flag (the
table-wide channel would hand villains the tell that beat exists to mask).

Built instead: the contract test. The client's `PRE_ACTION_EXEC_GRACE_MS`
(2500ms) must cover the engine's `preActionVisibleMs` (900ms) plus
`PRE_ACTION_GRACE_RTT_MARGIN_MS` (1000ms) — asserted by a test that reads
BOTH files, so raising the beat without raising the grace (which would put
the flash back on every pre-action) cannot land.

## 4. The glitch fix is measured, not believed

Two new bus events (`SHELL_STALENESS_CHECKED` with both outcomes and a
source, `SHELL_RELOADED` with page age) emitted by useShellUpdateGate. The
KPI: stale-rate near zero on shell-updated/controllerchange sources, and no
SHELL_RELOADED long after paint. Pinned in shellUpdateGate.test.ts.

## 5. Hero Hub remembers the last-used tab

Per-session (sessionStorage, try/catch both sides — blocked storage falls
back to Throwables, never throws). `tests/unit/heroHubLastTab.test.tsx`.

## 6. git-safe-push.sh no longer manufactures undeployable commits

The script hardcoded `Club Arena Agent <agent@smarter.poker>` with
`--no-verify` — the exact identity Vercel sends to BLOCKED (playbook §5,
CHECK 15), committed past the identity guard by the one script every agent
is told to trust. Found live 2026-08-29: three local commits authored by it
on the shared clone. Now commits as `Smarter-Poker`, same as
guard-commit-identity.sh enforces. (Host-side, same sweep: the GLOBAL git
identity on the Mac was `Agent <agent@smarter.poker>` and is now
Smarter-Poker; hooks verified healthy via ensure-hooks.sh; the 16:20
git-unstick stash held only a junk file and was dropped.)

## 7. Shell headers: measured, deliberately unchanged

`https://smarter.poker/hub/club-arena` answers 135-190ms total with
`x-vercel-cache: HIT` and an ETag — inside the SW's 300ms freshness-race
budget. No World Hub header change; there is nothing to win and staleness to
lose.

## Verification

`npx tsc --noEmit` clean; suites green (hero-avatar law, heroHubLastTab,
preActionPanelGate incl. timing contract, shellUpdateGate incl. telemetry
pins, swBootLatency, animations-always-play, no-auto-table-switch). Full
suite runs on the PR's required checks.
