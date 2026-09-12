# A hung drain switched off the only wake left

2026-09-11. Found while sweeping for more instances of the day's recurring
shape: a net placed after the condition that makes it unreachable.

## The wedge

`pollIsDue` is the 5-second safety poll's gate:

```ts
if (state.drainRunning) return false; // always wins
if (!state.retryArmed) return true;
return state.msSinceLastDrainStart > RETRY_MAX_MS + 2 * pollMs; // the escape
```

`drainRunning` is `drainPromise !== null`. The escape on the last line is
written for a stuck RETRY - its own comment says "a lost timer, a fenced
epoch" - and it is unreachable for a stuck DRAIN, because the first line has
already returned. One pass whose promise never settles takes the poll out of
service permanently.

It wedges completely because the other two wakes are gone on this host: the
Realtime channel is in `CHANNEL_ERROR` (logged repeatedly) and LISTEN is
unconfigured. The poll is the whole net.

## Measured live

|                                               |    21:14 |    21:27 |    21:29 |
| --------------------------------------------- | -------: | -------: | -------: |
| `poker_hand_projection_drains_total`          |      324 |      324 |      324 |
| `..._drain_results_total{result="projected"}` |   73,438 |   73,438 |   73,438 |
| `poker_hand_projection_outbox_depth`          |   24,442 |   26,618 |   27,356 |
| oldest row                                    | 42.5 min | 49.6 min | 51.6 min |

The engine was healthy and dealing throughout. The wedge began during a Docker
image build **on the same host** (see
`docs/audits/2026-09-11-the-engine-builds-its-own-replacement-while-dealing.md`),
when the box was at load 20 and every database call was slow.

## The fix

The pass is bounded. `withDeadline` rejects if a drain has not settled inside
`HAND_PROJECTION_DRAIN_DEADLINE_MS` (120 s, env-tunable within 10 s to 10 min),
so `drainPromise` always clears and every net that already exists resumes: the
poll answers again and the causal retry re-arms.

**Deliberately not** "let a second drain start beside the first". Preserving
per-table chain order is the entire purpose of this worker, so two concurrent
passes is the one thing that must not happen. Making the promise settle
restores the nets without ever running two.

`poker_hand_projection_drain_age_ms` is new: the age of the pass in flight,
zero when none is. A wedge used to look exactly like a quiet outbox - a counter
that simply stopped moving - and now it has a series of its own.
`HandProjectionDrainWedged` fires on it at three minutes, which should be
unreachable given the 120 s bound; if it ever fires, the bound itself failed.

## A note on how nearly this was reported wrong

The first read of `drain_results_total` showed only `deferred` and `failed`,
with no `projected` line, and that reads as "projection has never worked". It
was a truncated response - `/metrics` was timing out during the build - and
`projected` was 73,438 all along. The conclusion changed completely on the
second, clean read. Worth recording next to CLAUDE.md 10.86: a partial answer
is not a small version of the real one, it is a different answer.
