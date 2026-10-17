# Private Lightning Pool Status Requires Approved Membership

The definer-rights pool-status reader treated every club membership row as permission to read private metadata. Pending and removed members could bypass the corrected lobby visibility policy through the explicit RPC, and private-club games without their own private flag were also exposed.

Use the same private-club/private-game boundary: the actual owner, active or approved member, or service may read it; ordinary public reads remain available. Preserve the complete response, own-session fields, ACL, ownership, stable volatility and search path. The short guarded migration refuses an unexpected predecessor or replay.

Native PostgreSQL reproduced both metadata leaks before the repair and verified refusal afterward, positive controls, unchanged output and permissions, and atomic predecessor/replay refusal. The required matcher-parity caller runs that regression. The authenticated access witness now records owner positive controls and explicit null refusals for both nonmember and pending states. Root packaging/operations qualification passed 96 checks and the integrated native parity chain passed 8 fixtures and 49 identical groups. Installation and actual corrected access remain pending protected delivery.
