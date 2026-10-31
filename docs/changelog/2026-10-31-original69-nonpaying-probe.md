# A genuine-service rollback prerequisite for original69

The existing operator control can commit the canonical original-charge refund,
but management MCP auth cannot call that service-only function and separate MCP
BEGIN/ROLLBACK calls do not enclose it. A fixed service-only wrapper now performs
the unchanged canonical settlement and idempotent replay, verifies original stored
economics against the actual posted components, then always raises an uncaught
exception. Its entire transaction rolls back. There is no new payer or canonical
settlement modification.

Only exact original d44/69 targets are eligible; natural20, prior103 and weekly
RAKEBACK are excluded. Execution requires the separate canonical32ff postimage and
original current quiescence. The protected manual workflow makes one request after
a durable uploaded intent, refuses reruns, treats lost acknowledgments as unknown,
and verifies aborted XID plus unchanged event-scoped state. It cannot activate an
engine, install a migration, retry or commit a financial operation.

Individual refund lines, original private roster and raw errors never enter its
public receipts. A private read-only original-basis projection supplies the stable
economic digest, while public evidence contains strict bounded aggregates only.
The existing original-recovery helper is unchanged by this follow-up; its separate
privacy correction has its own source owner. Migration installation and any actual
service probe remain with the coordinating original69 operation owner.
