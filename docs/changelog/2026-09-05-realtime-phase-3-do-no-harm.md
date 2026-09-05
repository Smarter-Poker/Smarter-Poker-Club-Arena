# Realtime programme, Phase 3 of 7 - Do no harm (2026-09-05)

Phases 1 and 2 made the platform able to SEE a table going wrong: the engine's
act-to-broadcast latency on every scrape, and the browser's own connection
failures arriving as `POST /client-event`. Neither changed what the client does
when a table breaks. This phase does, and it is the only phase of the seven
whose deliverables are both subtractions - two things the client will stop
doing.

Both are the same mistake in two places: **a recovery mechanism that fires
without checking whether it can possibly help.**

---

## 1. The auto-reload failsafe no longer reloads an auth refusal

### What was there

`TablePage` carries a failsafe: twenty seconds of a `'failed'` engine socket
and the page reloads itself, throttled to once every two minutes. It is a good
failsafe for the case it was written for - a socket wedged in a way a fresh
page fixes.

### Why it was harmful on 2026-09-03

It cannot fix an auth refusal, and it did not know it was looking at one. The
fresh page presents the same token to the same refusal and arrives back at
`'failed'` twenty seconds later - having thrown away the felt, any buy-in
overlay and any armed pre-action on the way. That is the reload loop Dan
watched all night, and from outside it is indistinguishable from bad Wi-Fi.

**The status alone cannot tell you.** `auth_failed` is a state
`EngineStateClient` passes THROUGH, not one it rests in: it sets it on a 4401
and then calls `scheduleReconnect()`, which immediately sets `'reconnecting'`
and, at `maxRetries`, `'failed'`. By the time the failsafe's twenty seconds are
up, an auth refusal and a dropped link are the same word.

### What it does now

The cause is remembered separately - from the 4401 close, from an `auth:`
close reason, and from the `auth_failed` status - and it is **sticky for the
outage**, cleared only by a socket that actually reaches OPEN. An auth refusal
followed by nine 1006s is still an auth outage, and reading only the most
recent close would forget that.

Two cases sit under that one flag and both are answered:

- **the session is genuinely dead**: `lib/sessionRevoked` (Phase 0, PR #2992)
  already probes GoTrue, shows a full-screen prompt saying why, and redirects
  to sign in. All this phase has to do is not reload the page out from under
  that prompt.
- **the session is ALIVE and the ENGINE is refusing it** - its own auth path
  broken, a rotated key, GoTrue unreachable from the box. The reconnect ladder
  underneath is still running and will reconnect the moment the engine
  recovers. A reload adds nothing and costs the player their table. **This is
  the case nothing handled before today.**

### It is not silent in either direction

Dan, 2026-09-04: "YOU NEED TO GIVE A PROMPT TO LET THE USER KNOW WHAT THE ISSUE
IS... NOT JUST SILENTLY FAIL." A suppression that says nothing would have been
the same complaint in a quieter costume.

- **To the player**: the connection banner stops blaming the connection. It
  says `The Table Cannot Verify Your Sign In. Still Trying` (Title Case, no em
  dashes, CLAUDE.md 5.7) instead of `Connection Lost. Trying To Get You Back` -
  which invites exactly the hard refresh that cannot help. Present continuous
  on purpose: something is still happening on their behalf. `connecting` and
  `idle` are left alone - the first may still succeed, the second is a
  seat-first table with no socket yet.
- **To the platform**: a new `reload_suppressed` beacon reason. This is the
  series that separates "the network is bad" from "these players cannot
  authenticate to a table", which is the sentence nobody could say for
  twenty-two hours. It is a symptom report, so - like `auto_reload` - it never
  inflates the per-user reconnect count that `PlayersReconnectingRepeatedly`
  reads; the socket loss that caused it was already counted under its own
  reason, and counting it twice would put a player over the threshold at half
  the real rate.

The throttled reload survives untouched for the wedged-socket case. This phase
narrows the failsafe; it does not remove it.

---

## 2. An action applies once

### Why this is not paranoia

`POST /action` is retried on two paths:

- `submitAction` retries a 429 three times, at **300, 450 and 700ms**. Those
  delays were chosen to sit OUTSIDE the engine's 250ms per-user-per-table
  window so the retry would not be refused again. That is correct for the case
  it was written for, and it is precisely what makes a duplicate possible:
  **the one mechanism that would have collapsed two identical posts into one is
  deliberately stepped over.**
- `engineFetch` retries once more on a 401, after refreshing the session.

Both are safe _only while the first attempt provably did not run_. A 429 and a
401 are refusals, so the reasoning holds today - but it is reasoning about
someone else's status code, re-derived by every future reader, protecting a
raise that moves real chips. A proxy that answers 429 after passing the request
through, a load balancer that retries a POST, an engine that starts returning
401 from inside the handler: any one of those turns a retry into a second
raise, and `handlePlayerAction` has no way to know it is looking at the same
intent twice.

### The shape

The client stamps one key per INTENT - generated once per `submitAction` call,
carried by every attempt inside it, including `engineFetch`'s 401 retry, which
re-sends the same `init`. Two retries of one tap share a key and can only apply
once; two separate taps are two intents, get two keys, and the engine's turn
logic judges the second on its merits, exactly as before.

Five decisions worth recording:

1. **The key travels in the BODY, not a header.** `Idempotency-Key` is the
   conventional spelling and it is wrong here: the engine is a different origin
   from the SPA and `CORS_HEADERS` allows exactly `Content-Type, Authorization`.
   A custom request header would fail preflight in every browser, and the
   "fix" would be widening a shared CORS constant and adding an OPTIONS round
   trip to the hot path of a poker action.
2. **A key is remembered only if the action reached the engine.** Not on 401,
   404, 429 or 500. Those mean "not processed". Caching a 404 would be a real
   regression: 404 is the normal answer for ~2 minutes after every restart
   while tables rehydrate, and remembering it would make a table that was
   merely still waking up refuse that player's action for a minute.
3. **A rejection is an answer and IS remembered.** If the engine said "not your
   turn", the retry gets "not your turn" - it does not get a second chance to
   land a raise a beat later into a pot that has moved on.
4. **One key with a different payload is refused, never replayed.** A key names
   one intent; if the action or the amount differs, handing back the other
   one's result would report a fold as a call. 409, counted, engine untouched.
   The client turns that into words, never a status code (Dan, 2026-08-19).
5. **It is optional, and silence is the old behaviour.** Old bundles stay
   served from the origin's additive asset pool (CLAUDE.md 1.1), so tabs open
   since before this shipped are posting actions right now with no key.

**The lookup sits ABOVE the rate limiter**, which is the subtle half. A replay
is not a new action; a 429 on one would send the client back round its ladder
and finally report "The table is busy" for an action that had already been
accepted - the precise lie this exists to prevent.

**There is no await between the lookup and the remember**, which is what makes
two simultaneous posts of one key impossible to both see `fresh` (Node runs one
turn of the event loop at a time). That absence is load-bearing, so the law
pins it rather than trusting a future reader to notice.

### What it publishes

`poker_action_idempotency_total{outcome=stored|replay|conflict}` on the
always-on registry - three series, no table id and no user id. `conflict`
should be flat zero forever and is the series to look at first if it is not.
All three are registered at zero on import: an absent metric and a zero metric
look identical on a dashboard and mean opposite things ("nothing has been
duplicated" versus "the guard is not deployed").

---

## Laws

- `tests/a-reload-cannot-fix-a-sign-in.law.test.ts` - the failsafe returns
  before the reload, the cause is remembered from all three sources and cleared
  only by an open socket, both announcements happen, the reload survives for
  its own case, and the predicate inlined into TablePage (to keep
  `sessionRevoked` out of the entry chunk) is **executed from source** and
  proved identical to the exported one on every close code.
- `server/src/http/theSameActionAppliesOnce.law.test.ts` - all nine pins above,
  including the two orderings (lookup above the limiter, remember below the
  engine call) and the absence of an await between them.

Both registered under `docs/laws.d/`.

## Phase 3 audit - two defects in my own code, same day

Both were in the direction that matters, and neither would have been caught by
any test that existed when they were written.

**1. The fingerprint discarded a non-numeric amount.** `actionFingerprint`
kept the amount only when `typeof amount === 'number'` and folded everything
else to the empty string. So a client sending `"50"` and one sending `"500"`
produced the SAME fingerprint - and a retry carrying a different raise would
have been answered with the first one's stored result. `submitAction` types
the parameter as a number and would not do that today, but the entire purpose
of this file is to stop depending on a caller behaving, and a coercion that
silently drops the amount is the wrong failure mode for the one field that
decides how many chips move. Every amount is stringified now; `undefined` and
`null` are the only empty case.

**2. A player could move both counters on demand - the Phase 2 self-alarm
defect, in a second place.** The lookup sits above the rate limiter by design,
so an authenticated player could post one spent key in a loop and drive
`poker_action_idempotency_total` as high as they liked. `conflict` is
documented as the series that should be flat zero forever, which makes it
exactly the number a false signal ruins - and a monitor a player can trigger
is worse than no monitor, because the first false page teaches everyone to
ignore the next one. Counted once per KEY now rather than once per request:
bounded by a map that is itself bounded, and the more meaningful number anyway,
since it counts INTENTS that were duplicated rather than requests that arrived.

Four pins added, including one that records WHY the counting has to be bounded
here: the limiter that would otherwise absorb a loop is downstream of the
lookup, on purpose.

## Not in this phase

The `restart_in_ms` handoff frame and the protocol version negotiation belong
to Phase 4; per-socket re-auth and the socket cap to Phase 5. Nothing here
changes what any seat is owed, and horses are untouched in both directions - a
horse's action never crosses `POST /action` (the engine is its input device,
CLAUDE.md 10.5) and a horse has no browser to reload.
