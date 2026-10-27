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
a stopped manager never acknowledges it. No new timer, scan, migration,
financial path or deployment mechanism is added.

Live observations found seated capacity tables with pending receipts on a
running, non-paused event while its manager continued processing busts. The
masked runtime log does not identify which Realtime/admission edge lost the
specific historical wake. This change fixes the reproduced source gap; it does
not claim to repair a frame never delivered by a healthy transport. Protected
checks, publication and affected live proof remain separate requirements.
