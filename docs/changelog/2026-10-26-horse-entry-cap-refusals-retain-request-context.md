# Horse entry cap refusals retain their original request context

The registration worker aggregated database messages after a refused entry but lost the requested tournament and attempt time. That made a natural four-game-cap refusal impossible to bind to its original event after the database transaction rolled back.

The original RPC caller now emits a typed diagnostic only for SQLSTATE 23514 with the exact booking-cap message and matching requested horse. It retains the tournament, horse, pre-call timestamp and committed-game load; arbitrary provider text is excluded. The existing aggregate warning, registration result, backoff and money path are preserved. No migration, retry, observer loop or synthetic registration is added.

The connected service regression fails against the original caller because no attributable event exists. The repaired caller retains one event for the actual failed request, does not retry it, and refuses mismatched actors, SQLSTATEs, unrelated constraints and appended payloads. A natural RUNNING-entry witness still requires the deployed original event and authoritative tournament lifecycle readback; source tests alone do not establish that witness.
