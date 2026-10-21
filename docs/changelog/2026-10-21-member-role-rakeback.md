# Edit Individual Rakeback From The Member Role Panel

The current Player or agent role remains clickable and has a solid cyan frame plus Current text. It opens the existing agreement for editing without changing the role or opening a funding prompt. Agent promotions continue to require a deliberate agent rate.

The dedicated authorized RPC checks active membership, current role, downline scope, upline caps, existing child agreements and the editor's expected rate. It serializes with the existing agent agreement lock and returns the saved rate. Refused or unconfirmed writes require a fresh read before another attempt. The editor converts percentages to database fractions and announces the confirmed change to existing consumers.

An explicit player zero is distinct from an inherited offer. The original earning-time membership history and original pricing/check/write functions retain that distinction; prior history keeps its former interpretation. Changes are audited. No wallet, payout or already-settled amount is changed by this delivery.

Local PostgreSQL regression covers authorization, positive and zero rates, rate caps, role changes, stale and concurrent writers, child agreement protection, original history capture and migration replay refusal. Real component tests cover percentage conversion, current-role clicks, duplicate submissions, validation and refusal/reload behavior. Rendered at 393px and 1200px using real components with isolated transport; live production proof remains separately recorded in the task checkpoint.
