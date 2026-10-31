# Bind bootstrap to the observed static origin

Read-only publisher inspection 40841122137 reported a 4,880-byte aggregate Caddyfile with SHA-256 `cbf77db44f27c7d3640362be6e8271218a85ec3ba808973b89930515f2931d79`. Those exact bytes are maintained in `infra/ca-origin/Caddyfile` at protected historical commit `3328ea341a2d1e6c55452511d93dd4b75606670e`.

The reviewed bootstrap preimage now uses that exact source. The replacement configuration, entire-aggregate comparison, drift refusal, static identity proof and guarded rollback are unchanged. No host configuration was read or changed by this source correction. Bootstrap and authenticated activation still require their separate protected provider results; paid Realtime remains enabled.

Obsolete comments inside the captured preimage are retained as literal comparison bytes, not current publishing instructions.
