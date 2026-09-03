# A Dead Session Is Not A Signed-In One

**Date:** 2026-09-03
**Scope:** `src/services/sessionLiveness.ts` (new), one probe wired into
`src/services/EngineSocketMux.ts`, 14 pins.

## The report

Dan: "REAL TIME CONNECTIONS AND LOADING OF CLUBS FROM THE CLUB ARENA LOBBY IS
100% DEAD."

## What was actually measured

Loaded the lobby in his own signed-in browser:

```
[error] WebSocket connection to 'wss://engine.smarter.poker/ws/multi' failed
```

Club cards rendered names and IDs but **MEMBERS 0 / LEVEL 0 / ACTIVE 0** on the
first read, resolving to the true figures (417 / 26 / 408 for Deep Stack
Society) about a second later. So the club data was slow, not dead. The sockets
were dead — every one, every retry.

Working down the stack, all of it ruled out with evidence:

| Suspect                                  | Verdict                                                              |
| ---------------------------------------- | -------------------------------------------------------------------- |
| Published bundle wrong URL/key           | No — correct project URL and publishable key baked in                |
| RLS on `clubs` / `club_members`          | No — policies correct, rows readable                                 |
| The three lobby RPCs                     | No — all 200 from the browser with the real session                  |
| Caddy not upgrading WebSockets           | No — a well-formed handshake reaches the engine and gets a clean 401 |
| Engine missing the `/ws/multi` route     | No — present in the running image                                    |
| Engine cannot reach GoTrue               | No — `/auth/v1/health` 200 in 184 ms from inside the container       |
| Version skew, IPv6 upstream, header size | All disproved by direct probes                                       |

Then the same handshake with a **genuine, unexpired** token, both through Caddy
and straight at the engine:

```
HTTP/1.1 401 Unauthorized
```

and, replaying the engine's own auth call inside the container:

```
raw  /auth/v1/user → 403 {"error_code":"session_not_found",
                          "msg":"Session from session_id claim in JWT does not exist"}
sdk  getUser()     → "Auth session missing!"
```

His live tab held an access token that was **valid for 6.9 more days**, whose
`session_id` (`64cba0cf-…`) was **absent from `auth.sessions`**, and whose
refresh token answered `Invalid Refresh Token: Refresh Token Not Found`.

## The mechanism

Two validators, two different questions:

- **PostgREST** checks a JWT's signature and expiry. Nothing else. Every read
  keeps working, so the app looks signed in.
- **GoTrue** — which the engine calls to authenticate a socket — also checks
  that the session still exists. It said no.

So the moment a session dies underneath a live tab, the player keeps all their
data and loses every live update, with no error they can act on. The access
token's lifetime is the blast radius, and this project issues **seven-day**
tokens, so a corpse can masquerade for a week.

Sessions die for ordinary reasons, above all refresh-token rotation: this origin
serves both the Hub and Club Arena from one `smarter-poker-auth` key, and
presenting an already-rotated refresh token makes GoTrue revoke the family. The
lock comment in `src/lib/supabase.ts` already records that history — what was
missing was any reaction to the aftermath.

The engine was right to refuse. The client was wrong to keep asking, for days,
with a token it could have checked in one call.

## The fix

`confirmSessionIsLive()` asks GoTrue the same question the engine asks
(`auth.getUser()` — a network call that validates against `auth.sessions`;
`getSession()` reads localStorage and would return the corpse). The mux calls it
when a socket closes **without ever having opened** — a refusal, not a dropped
connection. On a dead session it signs out locally and emits
`smarter-poker:session-dead`, so the player is sent back to sign in instead of
staring at a lobby that quietly never updates.

Deliberately conservative, because the opposite mistake is worse:

- It acts **only** when GoTrue says in as many words that the session or its
  refresh token is gone. A network failure, a 5xx, a timeout, a throw, or a
  "no user and no error" all leave the session alone.
- One probe per 30 s however many sockets are flapping, and one announcement per
  dead session — a reconnect storm cannot become a probe storm.
- `signOut({ scope: 'local' })` — a global sign-out would revoke sessions this
  tab does not own, and the one it would revoke is already gone.

## Still open, and not code

The seven-day access-token lifetime is the amplifier: it is what turns a
revoked session into a week of silent half-working app. Supabase's default is
one hour, and the project is at the 604800-second maximum. Shortening it is a
dashboard setting, Dan's to make.

## Verification

14 pins; client suite 905 files green; typecheck clean.
