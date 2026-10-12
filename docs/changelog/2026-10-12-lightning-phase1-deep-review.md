# Lightning Phase 1 Deep Review

The operator-control review reproduced three gaps before starting Phase 2:

- Two concurrent calls using the same operation UUID on different clusters could both commit configuration changes and events, while `ON CONFLICT DO NOTHING` retained only one receipt.
- The client accepted incomplete or mismatched success receipts and could display Done. Contradictory ALREADY receipts could also bypass audit validation.
- The private-pilot setup accepted `ok: true` without proving the acknowledgment belonged to its operation. Already-correct configuration could hide a missing or incorrect audit receipt.

## Repairs

`20261012143829_lightning_operator_request_ownership_is_global.sql` claims transaction ownership of the operation UUID before any cluster lock or side effect. Contention returns REQUEST_IN_PROGRESS without saving a refusal or changing state. Receipt insertion now fails closed. Authorized cross-operator replay, including the documented first-answer behavior when a reason or arguments differ, remains intact. Installed migrations are unchanged.

The control client validates the action, cluster, request ID, before/after state, setup values and audit event. ALREADY requires a true idempotency marker and an explicit null event. Malformed responses and REQUEST_IN_PROGRESS retain the original complete decision and UUID for recovery; they do not show a success toast or rotate the operation ID.

The pilot helper validates operation and audit identity before emitting a qualification receipt. It preserves historical cached window receipts whose state predates the new window field, using their original detail plus a fresh configuration readback. It rereads the game and roster after the setup operations, so a later activation or admission cannot be described as an inactive owner-only pilot using stale initial reads. Refusal text does not claim that earlier setup operations were rolled back. Its optional client factory supports isolated regression tests; production still uses the configured Supabase client and authenticated service identity.

## Connected review and verification

The review traced both setup controls through their dialogs, RPC arguments, authorization, configuration transaction, immutable receipt, event producer, authenticated club channel, refresh/reconnect consumer and persisted dashboard readback. Existing loading, stale-response, hidden-tab, reason, focus, cancellation, permission and financial safeguards remain in place. No new polling, release watcher, gameplay activation or financial fixture is introduced.

The maintained PostgreSQL harness reproduces the old two-event/one-receipt failure and verifies corrected same-cluster and cross-cluster contention, independent operations, rollback recovery, legacy replay, exact event/receipt counts, authorization, unchanged money/stacks and migration reapplication. Focused client regressions fail before the receipt corrections and pass afterward. Isolated pilot-flow regressions reject malformed acknowledgments even when configuration already matches, while valid current, ALREADY and historical replay receipts succeed.

Required checks, protected integration, exact migration installation, normal client publication and affected production verification remain separate delivery evidence in the existing task checkpoint. The original Phase 1 release is already merged, installed and published; these review repairs require their own protected delivery. Gameplay, actual integrity signals and later-phase launch coverage are not certified by this review.

Real-time law: triggered by `lightning_operator_changed` discrete WS event, no snapshot diff.
