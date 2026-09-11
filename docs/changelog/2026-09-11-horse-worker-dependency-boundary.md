# Horse worker dependency boundary — D5 prerequisite

The existing LOCAL worker now supplies production dependencies explicitly to
`HorseDecisionWorkerRuntime`. Importing or constructing the runtime no longer imports
Supabase/service-role services or starts mind persistence, telemetry flushes, solver refreshes
or governor sampling. Omitting dependencies fails immediately; there is no production fallback.

`horseDecision/localDependencies.ts` retains the existing local HorseLogic/HorseMind, RNG,
governor, solver-store, persistence and telemetry bindings. The actual `worker.ts` entrypoint
loads these bindings inside the worker-thread branch and passes them to the runtime.
`localServices.ts` composes the lifecycle without importing production services. Construction
is inert. Startup still starts persistence and telemetry before hydration, waits for the
persisted mind and history/solver loads before READY, then starts periodic refreshes. Shutdown
stops clocks before joining the two durable writers. Failed initial hydration stops the same
local services and does not claim READY. The actual runtime joins in-progress startup before
stopping, so late hydration cannot rearm loaders after shutdown. Stop invokes every owned clock
hook and joins both writers even when one hook throws; it reports aggregated failures and refuses
to restart an owner whose prior stop failed.

The decision and effect paths retain their existing ordering. FAST calls HorseLogic with
`observeMind: true`; already-authoritative public actions immediately update local opponent
memory and its dirty sets even while speculative intent effects are captured. DEEP uses
`observeMind: false`; it does not learn that history again or apply its speculative effects.
Completed-hand observations and selected intent commits still execute on the same worker FIFO.
The change does not replace in-hand observations with completed-hand-only learning.

Validation includes a native Node process with no service-role credential, no Vitest environment,
and explicit traps rejecting production service imports, network requests and automatic writer
timers. It imports the runtime, lifecycle composer and main-thread entrypoint, constructs the
actual lifecycle composer without starting its hooks, and exercises an explicitly injected
runtime through READY, STATUS and shutdown with zero external effects. Local lifecycle tests
use the real HorseLogic/HorseMind and replace only service I/O: they verify hydration ordering,
failure cleanup, FAST dirty observations and deduplication, selected effect commits, and the
DEEP → completed-hand → FAST observation timeline. Existing source-location guards now follow the real local binding/lifecycle path while retaining
one-boot-load and ownership assertions. These tests do not claim production database
or account-grant verification.

This is a prerequisite, not a remote or shadow activation. There is no network transport,
remote identity, fallback router, new persistence authority or remote writer. The narrow data
identity, public observation/effect replay receipts, allowlisted network DTO, original action
deadline/fallback reserve and remote-loss lifecycle remain separate D5 requirements. The local
production path remains authoritative. No GameServer, table turns/dealing/seating or
EngineTelemetry code is changed by this slice.

Validation completed locally: `npm test` in `server/` passed 9,372 tests in 685 files
(145 existing test skips, one skipped file); `tsc --noEmit` and formatting passed.
The native probe ran on Node 26.3.0 with zero external effects and no service-role or
Vitest environment. Production remains pinned to its existing Node 22 image; this
change does not alter that image or claim a production installation. All 12 extracted
compute/mind/telemetry/RNG bindings match the original parsed source.

The [validation receipt](evidence/2026-09-11-horse-worker-dependency-boundary.json)
records source hashes, commands, test counts and local evidence locations. Reproduce
the import test with `npm test -- src/engine/horseDecision/pureImport.test.ts` from
`server/`; run the full server suite before integrating this prerequisite.
