# Engine runtime dependency input boundaries

The engine's locked runtime dependency tree contained vulnerable WebSocket,
UUID and OpenTelemetry parsers. This change updates only the server runtime
dependency declarations and their transitive lock entries. It is a source
candidate based on `a8be599ec0e3a53affbb6b14c7efe902c8729f14`; production has
not been changed or certified by these tests.

| Dependency                         | Previous lock       | New lock | Reason                                                                                            |
| ---------------------------------- | ------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `ws`                               | 8.19.0              | 8.21.0   | Bound fragmented-message accumulation and reject unsafe close-reason views.                       |
| `uuid`                             | 13.0.0              | 13.0.1   | Reject out-of-bounds output buffers in v3/v5/v6.                                                  |
| `@sentry/node`                     | 10.46.0             | 10.54.0  | Remove the vulnerable unused HTTP instrumentation dependency and take compatible tracing updates. |
| `@opentelemetry/core` (transitive) | 2.6.1, nested 2.6.0 | 2.11.0   | Enforce incoming baggage entry, count and total-size limits.                                      |

These are targeted same-major runtime updates, without `npm audit fix`, force,
overrides, or test-runner changes. Sentry's upstream 10.54.0 release vendors
several integrations and removes the unused HTTP package, so many lock entries
disappear. The engine's existing Sentry initialization is unchanged.

## Actual exposure

- `EngineWebSocketServer` and `ChannelWebSocketServer` use the default `ws`
  receiver. Their message-size checks run after a message is assembled and do
  not independently stop excessive fragments. The new library supplies finite
  default fragment/chunk limits. Existing authentication, message protocol and
  rate limits remain unchanged. Application close reasons are strings; no
  multi-byte typed-array close caller was found.
- Horse rebuy and rabbit-hunt receipts call v5 with a string name and namespace,
  without an output buffer or offset. The vulnerable buffer API was not exposed
  by those call sites. Golden receipt IDs from 13.0.0 are unchanged in 13.0.1.
- Error reporting initializes Sentry only when a DSN is configured. Default
  integrations are enabled by that initialization. The baggage parser therefore
  belongs to a conditional runtime path; this audit did not read or establish
  production DSN state. No raised Node HTTP-header limit was found in server or
  workflow source, which also limits practical inbound header size.

The primary upstream references are the [ws close-view advisory](https://github.com/advisories/GHSA-58qx-3vcg-4xpx),
[ws fragmentation advisory](https://github.com/advisories/GHSA-96hv-2xvq-fx4p),
[ws 8.21.0 release](https://github.com/websockets/ws/releases/tag/8.21.0),
[UUID buffer advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq),
[OpenTelemetry baggage advisory](https://github.com/advisories/GHSA-8988-4f7v-96qf),
and [Sentry 10.54.0 release](https://github.com/getsentry/sentry-javascript/releases/tag/10.54.0).

## Validation

Native macOS arm64, Node 22.23.2, using a fresh server `npm ci`:

- Full server suite: **688 passed / 1 skipped files; 9,799 passed / 145 skipped
  tests**. The existing skipped tests remain skipped.
- Ten new tests use real loopback sockets and installed libraries: valid JSON
  fragmentation, excess-fragment refusal before application delivery, safe close
  bytes, v3/v5/v6 buffer rejection, stable v5 IDs, baggage limits, and real Sentry
  initialization/capture/flush through an offline transport.
- The bounded old/new parser probe reproduced missing limits in the previous
  packages and the corrected limits in the new tree. Both financial name-format
  UUIDs matched exactly.
- TypeScript build passed. A separate fresh `npm ci --omit=dev` loaded the
  patched runtime packages and contained no Vitest installation. The existing
  Dockerfile prunes dev dependencies; no Linux image was built in this audit.
- Server runtime `npm audit --package-lock-only --omit=dev`: **zero findings**.

Exact source, lock, audit and validation fingerprints are recorded in
[`evidence/2026-09-11-engine-runtime-dependencies.json`](evidence/2026-09-11-engine-runtime-dependencies.json).

## Separately scoped development dependency work

The full development audit still reports seven package findings: one critical,
three high and three moderate. Vitest remains 2.1.9; Vite, vite-node,
`@vitest/mocker`, esbuild, nanoid and postcss are also in that development tree.
The checked-in server test configuration uses Node `vitest run` without UI,
browser mode or an exposed API host. This does not declare the old tooling safe
for other uses.

The [Vitest UI advisory](https://github.com/advisories/GHSA-5xrq-8626-4rwp) and
[mocker redirect advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)
have different affected surfaces. Vitest 4.1.11 is a patched candidate supporting
Node 22; the audit tool's proposed 5.x major is not required solely for those
two fixes. Moving from this repository's 2.x runner needs a separate compatible
Vite/esbuild/tooling resolution, config and mocking review, and complete native
and CI regression proof before adoption. That major migration is not included
in this runtime patch.
