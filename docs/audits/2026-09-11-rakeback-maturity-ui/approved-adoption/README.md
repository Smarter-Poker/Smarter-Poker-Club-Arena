# Approved Legacy Rakeback Adoption

The exact approved backend was applied and verified. Root checked all six functions and both triggers at 07:50:03 UTC, including body, owner, security mode, ACL, configuration and signature details. Final migration readback at 07:53:52 UTC found exactly one reserved version 20260911072837 row containing one statement with the reviewed a55 SHA256.

The application tool generated version 20260911074903 because it has no explicit version argument. Root then used the preserved guarded metadata-only alignment to associate the unchanged statement array with the reserved version. The SQL was not reapplied. The alignment rechecked all six functions and both triggers and retained the original statement-array hash.

adoption.json indexes the final source/runtime/ledger evidence. approved-rakeback-adoption-final.json.txt preserves the exact original JSON receipt bytes; approved-rakeback-ledger-alignment.sql is a record of the metadata-only action already performed by root, not another migration or a request to execute it. Both files have recorded SHA256 hashes.

preparation.json and its peer review remain historical preparation records. Earlier rejection and pending-approval archives remain unchanged. The subsequent explicit approval and verified adoption supersede their pending backend state.

Paired UI publication still follows normal commit, PR, CI and publication gates. There were no live financial RPC probes, no common producer/bank finality assertion and no activation of the broader captured-source package. Existing native and component evidence retains its documented fixture and HTTP/RLS limits.
