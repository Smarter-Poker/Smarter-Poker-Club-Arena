# Administrative departure authority

The old handler submitted moderation history after the departure succeeded and ignored insertion failure. The replacement passes actor and club from the existing authorization result, validates the reason, and requires an engine-only database transaction before cashout or a deferred acknowledgement.

Migration 20260909040806 stores original actor, club, reason and occupancy in a private retained table and writes the existing moderation event in the same transaction as the accepted forced departure. Retries preserve the first authorization and do not duplicate that event. Application roles cannot directly read, overwrite or delete the retained authority. It has no cascading foreign keys. The moderation event explicitly represents departure_requested; the existing occupancy cashout receipt, joined by occupancy_id, is proof of completed payment.

The engine performs this transaction inside its seat boundary after rejecting an all-in departure, before an immediate or reserved-seat cashout, and before deferred success. The handler no longer writes fire-and-forget history. Request-body actor/club fields are not trusted.

Verification: 130 focused engine/handler/service tests; 73 disposable PostgreSQL transaction tests with the whole migration applied twice; full server 8,083 tests passed (73 database cases skipped there and run separately); full client 17,377 tests passed. Server and client TypeScript checks passed. Database tests cover audit insertion failure rolling back flags and authority, original-author retention, exact replay, profile/seat deletion retention, actual role denial, and stale-occupancy refusal. Existing moderation schema and its cascading profile FK were inspected read-only before building the fixture.

This migration and the occupancy bundle remain local and unapplied. Publication requires the remaining SQL hand-boundary/outer-lock work and compatible schema/engine/client adoption. This is not Phase 2 acceptance. Historical audit backfill, retained-authorization inspection after table deletion and session-close reason classification remain explicit review items.
