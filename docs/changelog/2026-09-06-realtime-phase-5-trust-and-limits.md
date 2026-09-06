# Realtime programme, Phase 5 of 7 - Trust and limits (2026-09-06)

Phases 1 and 2 made a broken table visible. Phase 3 stopped the client making
things worse. Phase 4 handled the restart. This phase is about the three things
a live socket was still taking on trust: that the device's clock is right, that
the session behind it is still valid, and that one account cannot open sockets
without limit.

---

## 1. There is one server clock

**Phase 5 was meant to ADD a clock offset. It already existed - twice, with
opposite signs.**

```
utils/serverClock (2026-08-18)  offset = Date.now() - serverTime
                                serverNow() = Date.now() - offset

lib/serverClock   (2026-09-05)  offset = serverTime - Date.now()
                                serverNow() = Date.now() + offset
```

Two modules, the same function name, the same meaning, inverted arithmetic,
born eighteen days apart. Whichever one a file imported decided which clock it
got. Both compiled. Both returned a plausible number. **One wrong import path
would have turned a three-second-FAST phone into a three-second-SLOW one -
doubling the error on the turn ring instead of removing it - and nothing
anywhere would have said so.**

They also differed in quality, and the wrong one had the better feed:

- `utils` is latency-corrected (Cristian's algorithm, added after a 2026-08-28
  finding that the countdown was showing time the player did not have) and was
  fed **only by snapshots**. It drives the TURN CLOCK.
- `lib` says in its own header that "latency is ignored on purpose" - true for
  the ninety-second jackpot freshness gate it was written for - and was fed by
  **every EVENT and PING frame**, which is far more often.

So the accurate estimator got the fewest samples and the money-critical job,
while the rough one got a sample every twenty-five seconds.

Folded into one: the better estimator keeps the better feed, `lib/serverClock`
is deleted, and a law pins that exactly one module defines `serverNow`. The
sign flip is why this had to be surgical rather than a merge - the two tests
that exercised the deleted module were repointed with their expected signs
inverted and a note saying so.

## 2. Trust has to be renewed

A socket was authenticated ONCE, at the upgrade, and then trusted for as long
as it stayed open. **That is the 2026-09-03 outage from the other side.** The
fix that day stopped a revoked session OPENING a socket and said nothing about
the sockets already open - so with a seven-day access token and a tab left
open, a player who signed out, or was signed out by an admin, or had their
session revoked, keeps playing at a real table with real chips until something
else happens to break the connection.

Every live socket now re-asks GoTrue every five minutes, from the heartbeat
sweep - the one place every connection is already walked on a timer. Four
properties matter more than the number:

- **Only a definitive "no" closes.** `unavailable` - GoTrue down, a 5xx, a
  timeout - is never a refusal. That distinction is the entire point of
  `tokenDenial`, and inverting it here would sign every player out the moment
  auth had a bad minute: a worse outage than the one this prevents.
- **Staggered per socket.** Sockets that connect in the same second would
  otherwise come due in the same second five minutes later, forever - a
  self-organising thundering herd against auth, built by the mechanism meant to
  protect the platform.
- **Bounded per sweep**, so a backlog drains at a fixed rate.
- **The slot is claimed BEFORE the await**, or a slow GoTrue makes the same
  socket re-checked on every sweep until it answers.

## 3. A cap on sockets per account

Nothing bounded how many sockets one account could hold. Ten now - generous,
because the multiplexed transport means a tab is ONE socket however many tables
it carries, so a player on a laptop and a phone is two.

**The ARRIVING socket is refused, never an existing one evicted.** An open
socket may be carrying a hand; the new one certainly is not. Evicting the
oldest would also hand any client stuck in a connect loop a way to knock its
own player off the felt, repeatedly - a worse failure than the one being
bounded. Closed with 4429, which this client already treats as "slow down" and
backs off on.

## 4. The socket clocks agree, and clear any proxy idle timeout

A table socket is governed by four clocks in four files that cannot import each
other, and one of them is not in this repository at all:

| clock           | where                                    |
| --------------- | ---------------------------------------- |
| ping cadence    | `HEARTBEAT_INTERVAL_MS`, both WS servers |
| engine patience | `HEARTBEAT_TIMEOUT_MS`, both WS servers  |
| client patience | `EngineStateClient.STALE_HARD_MS`        |
| the proxy       | Caddy, on engine-01                      |

They work because of the RELATIONSHIPS between them, and every one of those was
a coincidence nothing checked. Now pinned: the engine pings at least twice
before it gives up, at least twice before the CLIENT gives up, and far more
often than the shortest idle timeout a proxy is likely to have.

**Measured on the box, 2026-09-06:** `/etc/caddy/Caddyfile` sets no timeout of
any kind for `engine.smarter.poker` - it is `reverse_proxy localhost:8080` and
nothing else - so Caddy v2.11.4's defaults apply and the 25-second ping keeps
the connection far from all of them. The relationship is pinned rather than the
number, because the number lives in a file this repository does not deploy.

### Found while measuring, and NOT fixed here

**The repo carries two Caddyfiles for `engine.smarter.poker` and neither is
what is running.** `server/Caddyfile` has CORS headers the live one does not;
`infra/monitoring/engine-01/Caddyfile` has the monitoring routes and a CORS
preflight block; the live file has neither. This is the same shape as the
Phase 1 finding about alert rules - a config that is not what everyone believes
it is - and it belongs to Phase 7, which is already scoped for exactly this
reconciliation. Recorded rather than "fixed", because picking a winner between
two repo files and a third live one is a decision, not a cleanup, and writing a
third source of truth is what CLAUDE.md 10.8 forbids.

---

## Laws, mutation-tested

| mutation                                             | result     |
| ---------------------------------------------------- | ---------- |
| a second `serverNow` comes back                      | 1 failed ✓ |
| the estimator averages instead of taking the minimum | 2 failed ✓ |
| re-auth closes on an `unavailable` verdict           | 1 failed ✓ |
| the re-auth slot is claimed after the await          | 1 failed ✓ |
| the cap check moves below registration               | 1 failed ✓ |
| the ping stops clearing the client's patience        | 4 failed ✓ |

- `tests/there-is-one-server-clock.law.test.ts`
- `server/src/transport/trustIsRenewedAndBounded.law.test.ts`
- `tests/the-break-clocks-agree.law.test.ts` (extended with the socket clocks)

Two new counters, both on the always-on exposition at zero:
`poker_ws_reauth_closed_total` (a trickle is someone signing out with a tab
open; a step change is a revocation loop) and
`poker_ws_socket_cap_refused_total` (flat zero in normal play).
