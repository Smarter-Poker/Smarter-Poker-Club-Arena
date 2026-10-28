# Restore Credit Line In Promote And Demote

Owner direction October 27 supersedes the October 16 prepaid-only rule for the role-change flow. When granting or changing an agent role, the operator chooses Prepaid or Credit Line beside the agent rakeback percentage and supplies a positive whole-chip limit for credit. Both terms travel through the existing atomic, authorized role RPC, with its parent caps, audit trail and notification.

The migration removes the blanket prepaid constraint and replaces its coercing trigger with funding validation. It changes no existing balances or agreements. Existing debt must fit the proposed limit; prepaid cannot erase unpaid credit. Credit authorization does not transfer chips.

Validation: TypeScript passed; role funding source contracts and rendered form tests cover missing choices, invalid limits, promotion and demotion between agent tiers, prepaid after credit, and server refusals. Isolated PostgreSQL exercised the exact migration, persisted credit terms, refused invalid terms and debt reductions, and returned to prepaid after settlement. Protected delivery and live installation remain tracked in the task evidence checkpoint.
