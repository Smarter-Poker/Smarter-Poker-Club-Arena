# server/src/services/aSubjectKeyReachesTheDedupeDoor.law.test.ts

The server financial-alert wrapper must forward `p_dedupe_key` and `p_entity_id`
to `fn_raise_server_financial_alert`, and the high-volume call sites (tournament
finish refusal, the two hand-level money alerts) must supply a key naming the
SUBJECT rather than the attempt. The database has implemented "one open alert per
thing that is wrong" since it was written; the wrapper passed neither parameter,
so 33 call sites could not reach it and one source alone held 15,426 unresolved
criticals for 1,003 tournaments that had all completed and paid in full.
