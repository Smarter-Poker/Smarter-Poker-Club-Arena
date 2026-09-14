# Reclaim private importer memory before its hard ceiling

Native run34779720626 successfully imported the exact image and matched786 runtime files. Its intended image-identity refusal also occurred correctly, but the qualification matrix failed because final memory.peak was536875008 bytes:4096 bytes above the512MiB ceiling. Both receipts retained zero OOM/kill increments and complete owned cleanup.

The private CI importer now sets and observes memory.high at448MiB to start reclaim below the unchanged512MiB memory.max. Swap remains disabled and CPU remains capped at one core. The existing strict measured peak ceiling is unchanged. Successful imports now also refuse a final peak outside that budget; previously only fault-matrix receipts enforced that final check. The final observation is retained even on refusal, and owned cleanup still runs.

The kernel documents temporary memory.max overshoot and memory.high reclaim/throttling: https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files . Earlier reclaim is a resource-tuning candidate, not a guarantee of bounded native performance. Fresh Linux qualification remains required before this importer can receive activation credit. No production importer, host limit, or runtime configuration is changed.

Validation:44 importer tests and81 related producer, bundle, qualification, archive, and resource tests passed with zero skips. Two new tests fail against the prior source (four expected assertions): the actual generated unit lacked memory.high and the successful worker accepted invalid final peaks. The old-source test supplies only the new fixture constant; it does not change the old decisions. These portable tests do not execute Linux systemd or Docker.
