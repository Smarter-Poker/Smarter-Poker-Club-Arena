# Player Management And Club Data Realtime Recovery

The deliberate recovery controls previously fetched reports without retrying
failed realtime joins. Player Management now retries its failed roster, wallet
or permitted audit binding; Club Data Refresh retries its degraded feeds.
Healthy subscriptions remain mounted. The channel hooks retire old bindings,
preserve their private authorization and discard late callbacks before a fresh
join can report success. An intentionally disabled audit feed does not retain
an obsolete failure state.

Row-channel recovery also lacked attempt ownership inside a mounted hook. A
late CLOSED or payload from the channel removed by the existing recovery
factory could overwrite its already subscribed replacement. A generation guard
now rejects that retired attempt, matching the private broadcast lifecycle.

Six mounted regressions failed against the original recovery wiring and passed
after correction: both page modes, the row hook and the private broadcast hook.
They verify failed-feed selection, no healthy-refresh churn, new subscription
success and rejection of retired status/payload callbacks.
An additional factory-recovery case failed before the generation guard and
passed after it; an audit-access regression covers intentional feed removal.

The earlier live timeouts also coincided with Supabase's published realtime
latency incident. The provider reports remediation, and the unchanged serving
client subsequently joined the roster feeds and all four Club Data feeds.
That temporal relationship does not prove the exact cause of this connection's
original timeouts. This change fixes the independently confirmed manual
recovery gap; it does not change provider quotas, authentication, permissions,
financial records or unrelated schedules.

Publication and final affected-route live proof are recorded in the existing
task checkpoint. No new polling or repair loop supplies this recovery.
