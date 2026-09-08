# tests/engine-recovery-healthcheck.law.test.ts

Engine recovery must tolerate a saturated event loop without turning load into an outage: image, run script, supervisor, verifier, and Caddy redaction stay aligned on probe timeout, per-process cold-boot grace, bounded wedge detection, standby semantics, and deletion of the WebSocket credential carrier from logs.
