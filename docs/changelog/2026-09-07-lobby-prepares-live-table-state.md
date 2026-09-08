# The Lobby Prepares Live Table State

The reported problem is every observer or joining player meeting a connecting
banner instead of arriving at an already prepared game. Investigation found
that ServiceBootstrap no longer prewarmed the game socket, lobby intent warmed
only page chunks until the game card opened, and tableWarmup explicitly threw
away every game-state frame it received. Warm subscription adoption existed,
but could only announce a connected transport, not populate the hand.

Changes:

- LobbyTable loads the table page chunks and shared transport on lobby entry.
- Desktop rows and mobile cards expose their cash table IDs to one viewport
  observer. Up to three visible cash tables warm using spare mux slots;
  pointer and touch intent prioritize another table before its click.
- The warm facade retains a recent snapshot and contiguous deltas, bounded by
  128 frames and 262144 string characters. Entry transfers those frames after
  opening the real facade, through the existing EngineStateClient reducer.
- Gaps, overflow, old data, engine restart and token changes prevent reuse.
  Private frames and historical animation events are never replayed.
- Speculative subscriptions yield before actual table entry. Four active
  tables are never displaced by background loading. This respects the live
  server limit of four subscriptions per physical connection.
- Roster refresh keeps an existing warm subscription alive instead of closing
  and reacquiring it every fifteen seconds. Older in-flight roster responses
  cannot overwrite a newer read. Observer/timer cleanup is owned by the lobby.

Verification: 59 focused mux, warmup and client recovery tests passed before
final checks. This includes driving the real EngineStateClient from a warmed
snapshot and delta, with no subsequent server state reply. TypeScript passed;
ESLint reported zero errors and five existing fast-refresh export warnings.
No banner is hidden by this change, and no fake game state is introduced.

Production health sampled at approximately 22:45 UTC reported running=true,
284 active tables, 261 hands in flight and zero stalled tables. It is a server
health observation, not a browser entry latency measurement. The available
browser reaches sign-in, so authenticated visual/gameplay verification is open.

## Continuing Scope

The user's full original audit remains active: duplicate physical connections,
subscription ownership, retries and reconnects, live game pacing, Supabase and
Hetzner communication, and retired PepNationRX references. A targeted search
found no PepNationRX occurrences in this checkout's src/server/scripts/.github;
that does not certify the rest of the estate or repository history.

Stalled channel handshake recovery was independently committed as ff3033eec8
and pushed on agent/codex-realtime-continuation-sep07/fix/channel-lifecycle-audit.
The prior chat's worktree remains separate and was still receiving commits.

Remaining entry coverage includes tournament observer/assigned-table paths,
rapid table changes with four live games, slow/mobile network measurements,
and complete authenticated production verification. Visible cash prewarming
is bounded client speculation, not a claim that every table in the estate is
subscribed by every browser. All-table server continuity remains a separate
audit concern. Do not call this programme complete from the test counts alone.

## Tournament Entry Follow-Up

Tournament Tables now applies the same viewport preparation to actual open
table IDs. Pointer, touch and keyboard focus prepare the chosen table. The
shared requestObserveTable utility warms before OPEN_OBSERVE_TABLE and
navigation, covering Ranking and other callers. TournamentAutoSeat starts
preparation before emitting TABLE_SEATED. warmTable also loads the correct
page chunks for all callers. Closed tournament rows are not prewarmed.

The expanded test run passed 138 tests across five files, including ordering
of observer preparation before the event and navigation, and refusal of empty
IDs. TypeScript and targeted lint passed. The earlier full local build passed
with source-map upload disabled; no approval guard was bypassed. The merge
hook reformatted tests/shipped-invariants.test.ts without changing assertions.
Authenticated browser verification and broader network soak checks remain open.

## Release-check follow-up

PR #3573 exposed two concrete integration issues. The lobby variant-menu
component test mounted the new real preparation effect, starting lazy route
imports that could still log after Vitest tore down its worker. The filter
suite now mocks that service boundary; the dedicated warm-up, mux and client
suites continue to exercise preparation and recovery. The other failed shard
was canceled, not an assertion failure.

The startup module gate measured three newly eager modules: authToken,
tableWarmup and ChunkPreloader, about 4 KB gzip above its prior baseline.
This is an intentional reviewed cost: global observer and tournament seating
entry points must start preparation synchronously before dispatching entry,
including a first click before the lobby chunk has loaded. Deferring the helper
until that click would restore a request waterfall. The measured initial
bundle remains below its existing size gate; only the reviewed module list is
updated, with no threshold increases or checks removed.

The blinding-off reminder's Take My Seat action now prepares its actual table
before the same seating event, covering the other entry branch in that component.

Live verification reached a signed-in Terms of Service screen. Automatic review
blocked accepting that agreement without explicit user authorization. No
authenticated table-entry timing has been claimed from that blocked session.

Final local follow-up: 147 tests across six files passed, full build and
targeted ESLint passed. The reviewed module-list gate passes; the unchanged
bundle-size gate measures initial 310 KB / 320 KB gzip and total
2448 KB / 2600 KB gzip. CI must still verify this updated commit.
