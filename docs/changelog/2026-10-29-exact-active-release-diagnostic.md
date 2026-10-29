# Exact active release diagnostics

The existing completed-release recovery reader cannot explain an active durable release whose hosted observer is still waiting. Add a separate explicit `active_release_observation` mode to the same pinned production-integrity transport. It selects only one validated run key and release SHA, reads fixed immutable request locations, and reports the two exact intake/release units through read-only `systemctl show`.

Journal evidence is restricted to each unit's observed invocation, the latest eight matching rows, 8 KiB and five seconds per command. Only reviewed phase/refusal codes and validated timestamps leave the host. Unknown messages are counted without exporting content. Missing transition requests, unavailable units and unavailable journals remain unknown. The result is an observation, never activation proof or authority to retry or recover a release. An earlier cause may be absent from this bounded view.

The explicit mode skips the nine ordinary audit/issue jobs and has its own observation concurrency lane. Scheduled audits and the original completed/sealed reader retain their behavior. Native fixtures cover identity binding, fixed arguments, malformed exports, filesystem refusal, process transition, unknown evidence and credential-content suppression.

Policy reader: 2026-10-29T09:11:58.418Z, version 2.9, manifest `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`. Canonical owner, operating law, hardening and reference index plus current repository, publishing, deploy, storage and task checkpoint references were read. No engine runtime, release transaction or maintenance admission behavior changes.
