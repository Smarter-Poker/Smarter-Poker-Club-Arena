# A refused scheduler wake retains its committed receipt

A manager receiving a durable wake before its scheduler registration could
reject the scheduling request and discard both its reason and generation.
Registration supplies a causal first sweep, but that sweep could no longer see
the already delivered late-registration work. The database receipt remained
pending. A focused reproduction on the original source loses the retained work
in three cases; the repaired source retains it and serves it on registration's
real first admission.

Retain the validated identity, reason and newest generation before asking the
scheduler to wake. Keep the existing acceptance result, lifecycle gates and
exact-generation acknowledgement rules. An ordinary wake invents no receipt;
a stopped manager never acknowledges it. No new timer, migration,
financial path or deployment mechanism is added.

Live observations found seated capacity tables with pending receipts on a
running, non-paused event while its manager continued processing busts. The
masked runtime log does not identify which Realtime/admission edge lost the
specific historical wake. The existing sweep admission now also reads its own indexed pending database
receipts before capturing work. This closes the separate handoff gap when a
healthy transport never supplies a frame: the original business owner consumes
the original committed request without another timer or background repair loop.
A bounded read validates identity, reason and generation before folding any row;
newer Realtime generations win. Read failure remains UNKNOWN, retains known work
and requests the existing causal retry without obstructing terminal authority.
Stop, abort, maintenance freeze and database entry authority still precede a
new dealer. Existing exact-generation acknowledgements remain unchanged.

The runtime witness showed an active manager with a seated capacity table still
unadmitted after 43 minutes; another recovered after manager readoption drained
durable requests. This proves an unresolved handoff class, but does not identify
the precise historical frame loss. Protected checks, publication and affected
live proof remain separate requirements.

The same PR carries a bounded October 26 Chicago owner window for these repairs.
It expires at local midnight and adds no announcement-minute restriction. The
fresh protected-main anchor is a readiness condition; delivery must separately
prove inclusion of the actual #8278 squash. Required checks, immutable staging,
two-minute lead, drain, database freeze, full 285-second rollback reserve,
rolling-hour seal and thaw remain required. An anchor consumed by another
release grants no later activation. No activation or dispatch occurs here.
