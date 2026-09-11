# Exact Engine Control Staging Reports Its Failed Guard

The existing control-staging step could exit before host intake without identifying which source, permission or environment prerequisite failed. This change emits stable `STAGE_*` failure codes with a named phase for identity, prerequisites, source lock/fetch/provenance, stage directory, archive, syntax and durability. It keeps exact-source and path checks, and adds a final durable-stage identity message only after the existing fsync sequence succeeds.

Diagnostics expose presence/readability and validated non-secret commit/run identities. They do not read the environment file, trace commands, log transport keys or print Git remote URLs. Raw remote/fetch errors are suppressed because a configured remote can contain credentials. Unexpected command failures preserve their exit status and report phase/line without `BASH_COMMAND`.

Executable tests run the actual remote workflow payload in a disposable filesystem, including successful first-attempt staging, invalid identities, missing environment, wrong repository, lock/fetch/provenance failures, archive/syntax failures and unexpected command failures. The repository's existing release-seal and portability tests remain required. This is compatible logging in the existing workflow; frozen v1 request/result/unit fields are unchanged.

Preparation depends on the already-owned #4317 path-guard repair. Local success is not host installation, publication or terminal E2E evidence. The existing release owner retains its active operation until explicit relinquishment.
