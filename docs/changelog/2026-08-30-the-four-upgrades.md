# 2026-08-30 — The Four Upgrades

The four items left open at the end of the 2026-08-29 pass, all built, wired
and tested. Two are Club Arena; one is World Hub (separate PR); one is the
engine plus its client half.

## 1. Agent previews no longer starve production deploys (World Hub)

Measured 2026-08-29/30: a Club Arena fix merged, synced into World Hub at
03:55, and did not reach smarter.poker until ~04:20. The Vercel build
concurrency pool was full of **preview** builds for `agent/*` branches pushed
by other agents in the same minutes; the production deploy for the sync commit
was **CANCELED while queued**, and the change only shipped by riding a later
commit's build.

Those previews are pure waste: an `agent/*` branch is created by
`agent-workspace.sh`, exists to be squash-merged, and is deleted after — nobody
opens its preview URL, and no required check is a Vercel deployment (the
required checks are GitHub Actions), so skipping them cannot block a merge.

`scripts/vercel-should-build.sh` now skips `VERCEL_ENV=preview` builds whose
ref starts with `agent/`, **before** the file-diff gate (that gate needs a diff,
which is the unreliable part on a shallow preview clone). Production is never
touched by the new rule. Pinned by `__tests__/vercel-build-queue.test.mjs`,
which runs the real script against throwaway repos — including the beat that
matters most: _a Club Arena sync on main still builds_, because if the branch
rule were ever applied without the preview check, that is the build that would
vanish and take every Club Arena release with it.

## 2. The shell telemetry has a reader

`useShellUpdateGate` has emitted `SHELL_STALENESS_CHECKED` and
`SHELL_RELOADED` since 2026-08-29 and **nothing subscribed** — the same shape
as `SHELL_UPDATED` itself, which the service worker posted for months to a
client with no handler. This fix is invisible when it works (the point is that
no reload happens), so with no sink there was no way to tell "holding" from
"quietly broken".

- `client_shell_telemetry` (migration `20260830_client_shell_telemetry.sql`,
  **applied to production via Supabase MCP**): six typed columns, RLS
  insert-your-own, no free-form payload. A KPI table, not an event lake.
- Two views answer the only questions worth asking:
  `v_shell_staleness_rate` (stale share per source per day — near zero on
  shell-updated/controllerchange means the SW freshness race is winning) and
  `v_shell_reload_lateness` (reloads inside the 15s startup window, which is
  the fix working, versus long after paint, which is the glitch Dan reported).
- `ShellTelemetryService` subscribes at the app root. It is throttled, writes
  only when signed in (RLS would refuse otherwise), swallows every failure, and
  sends the reload row with `keepalive` because the page it is recording is
  about to be replaced.

## 3. The Table tab has switches in it

Same weakness the Stats tab had before its figures were inlined: "Table" was a
tab containing ONE button that closed the hub and opened SettingsPanel. The
switches a player reaches for mid-session are now one tap from the avatar.

The rule that had to survive it is the one
`tests/unit/settingsHaveOneOwner.test.ts` defends: one owner, one persisted
copy. So the quick list is a `quick` flag on `TABLE_SETTINGS_META` — the same
array that drives the full panel, living beside the settings' single owner —
and the hub writes through the same `toggleSetting`. The hub holds no state,
touches no storage but its own tab memory, and never talks to the database;
`tests/unit/heroHubQuickSettings.test.tsx` pins all three.

## 4. One armed pre-action price, and it is the engine's

The client suppressed the ActionPanel by judging "can the engine still honour
this arm?" against a price the **browser** snapshotted at tap time, while the
engine judged the same question against `toCallAtSet` from its own
authoritative state. Two snapshots of one number, taken at two moments on two
machines: they agree almost always, and the "almost" is a flash on a hand the
engine was going to act, or — worse — no panel on a hand where the arm was
already dead and the player is on a running clock believing they are covered.

`/preaction` now returns `armedToCall` and the client adopts it, degrading to
the old snapshot if the field is missing (an older engine must not read as "no
cap", which would turn Call 15 into Call Any).

**It is a reply, not a broadcast** — deliberately. Announcing an armed
pre-action table-wide would hand every villain the tell that the engine's
visible pre-action beat exists to mask. Pinned, including a beat asserting the
value is never emitted table-wide.

## Verification

`npx tsc --noEmit` clean (client and server). Full client suite green.
The World Hub gate's own suite: 8/8.
