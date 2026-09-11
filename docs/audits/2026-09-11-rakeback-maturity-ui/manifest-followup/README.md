# Adopted helper manifest follow-up

The exact-head CI migration gate reported three missing helpers because its manifest lacked names already adopted in production. The root read-only catalogue at 08:55:48 UTC confirms all three public signatures and postgres ownership. The owned schema fragment adds only those names; the shared base snapshots and checker remain unchanged. The catalogue definition hashes refer to pg_get_functiondef, not the earlier prosrc body hashes.

The unchanged migration checker reproduced exactly three missing names before the fragment and passed afterward. Separately, the unchanged Phase 3 recertification file passed all eight tests locally; its timed-out CI case took 508 ms against the unchanged five-second limit. Resource contention is a plausible explanation, not reproduced by this focused run. No timeout, assertion, test setup or application code was changed.

The fragment corrects release metadata only. Existing a55/da06 SQL and frozen backend/UI inputs remain exact. No SQL was reapplied. The successor still requires normal CI and publication verification.
