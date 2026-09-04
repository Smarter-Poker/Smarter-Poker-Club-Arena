# 2026-09-04: a revoked session is not a reconnect

## What Dan saw

"ALL TABLES INSIDE THE CLUB ARENA ARE CURRENTLY DOWN, NOBODY CAN PLAY... THEY
ALL JUST SAY 'RECONNECTING TO TABLE' AND IT NEVER DOES... JUST SILENTLY FAILS."

## What it was, in order

1. **The engine was fine.** `/health` was `liveness: ok`, 267 tables
   expected dealing, 1,514 hands in the window, 5,730 hands in the ten
   minutes before I looked, no maintenance break, `fn_platform_frozen()` =
   false. `humansSeatedTotal` was 0 - which was the clue, not a symptom.

2. **Every table socket was refused with HTTP 401.** Reproduced from the
   built-in browser with Dan's own session: `/ws/table/<id>`, `/ws/channel`,
   `/ws/multi` and `POST /heartbeat` all 401 within ~240 ms. Confirmed on
   the Caddy-to-engine hop with `tcpdump -i lo port 8080`: `HTTP/1.1 401
Unauthorized` written before the handshake, every time. The engine
   itself verified tokens fine (a fake HS256 token got the right `bad_jwt`
   from GoTrue; `admin.listUsers` and a table query both succeeded with the
   `sb_secret_` key).

3. **GoTrue said the session did not exist.** `GET /auth/v1/user` with the
   browser's token: `403 session_not_found - Session from session_id claim
in JWT does not exist`. The token itself was valid: ES256, `kid` present
   in the live JWKS, issued 18:30 UTC that day, seven days to live.

4. **Something was deleting Dan's sessions every 15 minutes.** Supabase
   `auth_audit_logs`: a `login` followed one second later by a `logout`
   with `user_agent: "node"`, at :00/:15/:30/:45, 76 times that day, only on
   `daniel@bekavactrading.com`. First occurrence 2026-09-03 20:45 UTC.

5. **The cron.** World Hub `vercel.json` runs `/api/cron/login-probe` every
   15 minutes. It signs in with `PROBE_LOGIN_EMAIL` / `PROBE_LOGIN_PASSWORD`
   and tidies up with `anon.auth.signOut()` - default scope **global**:
   revoke every session this user holds, on every device. The Vercel env
   vars had been updated at 2026-09-03 20:15 UTC - thirty minutes before the
   first logout - to Dan's own account instead of the
   `probe-login@probe.smarter.poker` user the file header prescribes.

So: a monitor built to prove login works was signing the owner out of every
device four times an hour, and reporting `ok` each time.

## Why the client spun instead of saying so

Two facts, both worth remembering next time a table "silently fails":

- **PostgREST checks the JWT signature, not the session row.** Every lobby
  query, wallet read and World Hub API call kept returning 200. The app
  LOOKED signed in. Only GoTrue (`auth.getUser`) knows a revoked session,
  and the engine is the only thing that asks it.
- **A pre-handshake HTTP refusal is close code 1006 in a browser** - the
  same code as Wi-Fi dropping. `EngineStateClient` handled 4401 as
  `CLOSE_AUTH_FAILED` since day one; the server had never sent it. So the
  client did the only thing 1006 can mean and reconnected with the same
  dead token on the backoff ladder, forever. With a seven-day access token,
  supabase-js never attempted the refresh that would have failed and said
  "session gone".

## The fixes

### World Hub (PR #1343 merged; PR #1345 behind it)

- `signOut({ scope: 'local' })` on both paths of login-probe: end only the
  session the probe made.
- The probe refuses to sign in as anything but a probe account. Dan,
  mid-incident: "DON'T USE MY ACCOUNT FOR THE CRON, USE THE OTHER 'GOD MODE
  ADMIN ACCOUNT'. IT HAS THE SAME PASSWORD. KEEP MY ACCOUNT CLEAN." The
  allowlist is exactly `daniel@smarter.poker` (role `god`, "Smarter.Poker
  Official") plus the `@probe.smarter.poker` domain, and the law pins that
  his personal address never appears in the file.
- `PROBE_LOGIN_EMAIL` on hub-vanguard repointed to `daniel@smarter.poker`
  (production + preview) at 19:13 UTC; the password env left as it was.
- `__tests__/synthetic-probes-never-sign-out-a-person.law.test.mjs`: no
  headless code may call a bare `signOut()`.

### Club Arena, engine (this PR)

- `wsHelpers.ts`: `verifySupabaseToken` / `classifyGetUserError` return a
  verdict that says **why**. GoTrue 401/403/404 = `invalid`; unreachable,
  429, 5xx = `unavailable`. One classifier, shared by both servers.
- `EngineWebSocketServer` (`/ws/table`, `/ws/multi`) and
  `ChannelWebSocketServer` (`/ws/channel`): an **invalid** token completes
  the handshake and is closed with **4401 + `auth:<code>`**, which the
  browser can read. An **unavailable** verdict stays a pre-handshake
  **503** with `Retry-After` - the client sees 1006 and keeps retrying,
  which is right for an auth outage that is not the player's fault.
- The `verifyToken` injection point widens to `TokenVerdict | null`; a
  legacy verifier returning `null` is still refused as invalid (4401), so
  no test or caller changes shape.

### Club Arena, client (this PR)

- `src/lib/sessionRevoked.ts`: `probeSessionAlive` asks GoTrue directly
  (`getUser`, then one `refreshSession`). Verdicts: `alive`, `revoked`,
  `unknown`. **Unknown never signs anyone out** - a network error, a 5xx, a
  thrown fetch all keep the reconnect ladder running, so "the games can
  never freeze or die" (2026-08-21) still holds for a live session on a bad
  link. `revoked` clears the local session (**scope local only** - the
  server has nothing left to revoke, and a global sign-out from here would
  be the outage in reverse), records why in `sessionStorage`, and sends the
  player to `/auth/login?authError=no_session&redirect=<this table>`. The
  World Hub login page renders `no_session` as "No active session was
  found. Please sign in again."
- `EngineStateClient` and `EngineChannelClient`: an auth close (4401, or an
  `auth:` reason) probes immediately. For an engine that still answers a
  bare 401, `HANDSHAKE_FAILURES_BEFORE_SESSION_CHECK = 3` consecutive closes
  with no open in between probes too - about seven seconds on the ladder;
  one is a normal engine restart, two is a phone changing networks. The
  count resets on every successful open. The escalation sits below the
  coded branches (4404 / 4901 / 4429) so each keeps its own meaning.

### Club Arena, the rest of the sweep (this PR)

Dan: "MAKE SURE YOU FULLY CHECK THIS AND IMPROVE IT IN EVERY POSSIBLE WAY
SHAPE AND FORM." Four more things the first pass had not covered:

- **The HTTP path.** The engine verifies `/action`, `/heartbeat`,
  `/timebank`, `/preaction`, `/sitout`, `/straddle`, `/addchips`,
  `/actions/:id/me` and `/state/:id` with the same `auth.getUser()`, so a
  revoked session 401s there too - on every heartbeat, and the instant a
  player presses Call. That used to surface as "Server error (401)" and
  nothing else. `GameServerAPI.noteEngineResponse` now routes any 401 into
  the same session check (throttled inside the handler, so a heartbeat
  storm is one question). A dead session is caught even before a table
  socket is opened.
- **A refusal is a number.** `poker_ws_auth_refused_total{path, denied}` is
  rendered by `GameServer.getPrometheusMetrics()` - the always-on
  exposition, NOT the `ENGINE_METRICS`-gated registry, which is off in
  production (`ENGINE_METRICS` is unset in the container; checked). Two
  rules in `infra/monitoring/alert-rules.yml`, validated with `promtool`
  against the live Prometheus: `EngineRefusingSessions` (warning, six
  invalid refusals in 15 min) and `EngineCannotReachAuth` (critical,
  three unavailable in 5 min). Twenty-two hours of 401s paged nobody; now
  they would, inside half an hour.
- **This repo had the same habit.** Four scripts defaulted to Dan's
  personal address (`scripts/e2e-avatar-audit.mjs`,
  `scripts/e2e-mobile-overflow-audit.mjs`,
  `e2e-live/tournament-lobby-audit.mjs`, and `reset_test_user.ts` - which
  sets that account's display name to "New Player"), and `.env.example`
  taught every fresh clone to do the same. All five now read the account
  from `SP_EMAIL` / `TEST_USER_EMAIL` in `.env.local` and refuse to guess.
  `tests/e2e/support/temporaryCustomizationAccount.ts` signs its throwaway
  account out with scope local, same as everything else.
- **CLAUDE.md 10.10** records the rules so the next agent reads them
  before reintroducing any of this.

### Laws (all registered in docs/LAWS.md)

- `tests/a-revoked-session-is-not-a-reconnect.law.test.ts` - 16 pins, red
  against the pre-fix client (5 failures), green after.
- `server/src/transport/aRevokedSessionIsRefusedOutLoud.law.test.ts` - 15
  pins over a real socket: 4401 + reason on `/ws/table` and `/ws/multi` for
  an invalid token, 503 for an unreachable GoTrue, a good token still
  opens, the counter counts and the alert rules watch it.
- `tests/a-script-never-wears-a-persons-face.law.test.ts` - no bare
  `signOut()` in headless code, Dan's personal address in no source file,
  the four scripts refuse to run without an account. Red against the old
  tree (3 failures), green after.

## "Is anyone actually playing?" - two gauges, deliberately not an alert

Every one of the 46 alert rules on this platform stayed green for 22 hours,
and every one was telling the truth: the engine dealt 5,700 hands per ten
minutes, liveness was 1, no table stalled. The fleet is horse-heavy, so
`poker_active_players` read 6-8 throughout, its normal value. Nothing
anywhere distinguished "the fleet is busy" from "the fleet is busy and not
one human is in it" - which is why the outage was found by reading `/health`
by hand.

`poker_humans_seated` and `poker_tables_with_humans` now ride on the
always-on `/metrics`, so that question is one glance on a dashboard.

**They are gauges, not an alert, and that was measured rather than assumed.**
The first draft of this work was a `NoHumanCanPlay` alert on zero humans
seated. Before writing the rule I checked 14 days of `table_seats`: only 15
distinct hours saw a human take a seat at all, and multi-DAY gaps are
ordinary. "Zero humans seated" is this platform's normal state. That alert
would have paged almost continuously and been muted inside a day - which is
worse than no alert, because a muted alert is one nobody reads during the
next real incident.

The signal that IS alertable for this class counts **failed attempts**, not
occupancy, because one player retrying produces it regardless of how many
people are online: `poker_ws_auth_refused_total` and `EngineRefusingSessions`
above. During the outage Dan's client was retrying constantly, so that rule
would have fired within 15 minutes. `tests/...aRevokedSessionIsRefusedOutLoud`
pins the absence of a `poker_humans_seated == 0` rule so a later pass has to
re-measure before adding one.

## The player is TOLD (Dan, 20:45 UTC: "NOT JUST SILENTLY FAIL")

Dan's tab was still holding the token revoked before 19:00. The lobby looked
signed in, the table said "Reconnecting To The Table", and the only way out
was a manual log out / log in - because this PR had not deployed yet (it
went conflict-dirty three times on `docs/LAWS.md` while main moved), so the
client on his screen was the old one.

Two changes so the next person is told, not stranded:

- `announceSessionEnded()` in `lib/sessionRevoked.ts`: a full-screen prompt
  in **plain DOM** (the React tree may be mid-reconnect and the toast
  provider is a context this module cannot reach): "Your Session Has Ended /
  You Were Signed Out On This Device, So The Table Cannot Reconnect. Taking
  You To Sign In Again." with a **Sign In Now** button. Button goes now; it
  goes on its own after 4 s; never twice. The login page then also renders
  "No active session was found" via `authError=no_session`. Told twice, not
  zero times.
- The banner's `auth_failed` label said **"Signing You In Again"** through a
  22-hour outage in which nobody was being signed in. It now says
  **"Checking Your Sign-In"**, which is what is actually happening.

Law 6 in `a-revoked-session-is-not-a-reconnect` renders the prompt under
happy-dom and pins: role=alertdialog, the copy, button-once, auto-leave,
Title Case / no em dash (5.7), the redirect living inside the prompt's
callback, and the old banner string being gone.

## What I did not change, and why

- **The seven-day access token.** That is a Supabase Auth setting (JWT
  expiry), i.e. Dan's. With a one-hour token a revoked session would have
  surfaced through a failed refresh within the hour instead of never. Worth
  a look; not mine to flip.
- **AuthGuard.** It deliberately never redirects on session evidence in
  localStorage, which is correct for its purpose (OAuth callbacks, store
  resets). The revoked-session path bypasses it on purpose: by the time we
  redirect, GoTrue has said twice that the session is dead.

## Verification

- Server: `server/src/transport/**` 118 tests green including the new law.
- Client: the new law (16) plus `engine-state-client-recovery` (11) and
  `engine-event-ordering` (8) green; `tsc --noEmit` clean in both trees.
- Live: after the World Hub deploy, a fresh sign-in on Dan's account and
  `auth_audit_logs` showing no further `logout / node` pairs on it.
