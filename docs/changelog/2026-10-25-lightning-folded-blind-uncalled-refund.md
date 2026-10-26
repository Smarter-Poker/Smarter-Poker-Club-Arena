# A Folded Blind Keeps Its Uncalled Refund

FLO8 hand `737715a1-c486-45dc-ad1c-279b1215752c` froze its cluster at
15:03 UTC because a folded 0.25 blind lost only 0.24. The last caller was
all-in for 0.24, so the controller correctly returned the unmatched cent.
Lightning already records that return in `returned_uncalled`, but its SQL
settlement compared the final loss with the gross commitment at the fold.

The settlement predicate now reconciles all four facts: original commitment,
final contribution, declared uncalled return and final stack. A folder must
still win zero. Missing or incorrect returns still freeze the cluster;
conservation and the existing atomic physical settlement remain enforced.
Original fold commitments and settled records remain immutable. The existing
engine contract already carries the refund, so this is a database-only change.

The existing required PostgreSQL 17 settlement qualification reproduces the
refusal before the repair, then exercises the original hand and request through
the real physical stack writer. It also covers a second hand completing first,
exactly-once replay, conflicting requests, human and horse folders, ordinary
folds, malformed refunds, a winning folder, retained receipts and service-only
execution. The shared disposable catalogue restores its predecessor afterward.

Installation, safe recovery of affected frozen clusters and natural-hand
verification remain separate delivery steps.
