# Fleet reporting preserves unknown counts

The October27 digest said the horse fleet degraded on one heartbeat with up to zero horses stuck. The flagged heartbeat has horses_stuck NULL. The metrics producer coalesced an entirely unknown count to zero; the attention consumer then repeated that as an observed maximum.

The producer retains NULL and records the number of unknown observations and known samples. The attention consumer says the stuck-horse count is unavailable whenever any observation is unknown, including a legacy saved snapshot without completeness fields. A fully observed zero still displays zero. The original degraded/stuck warning thresholds remain unchanged, and no sent snapshot is rewritten.

Native PostgreSQL17 executes the exact captured attention function and the fleet aggregate extracted from the actual metrics function, applies the pinned migration, and reads the installed producer/consumer definitions back. It reproduces the old false-zero title and verifies unknown preservation, consumer wording, legacy snapshots, known zero and replay refusal. The unrelated daily metric collectors are outside this fixture. Function owner, ACL, SECURITY DEFINER, search path and volatility are asserted unchanged by the installer.

No registration, contribution parsing, financial record, schedule or engine changes are included. The suspected decimal-contribution defect was disproved by running the actual installed pattern and original native rollup; that proposed change was discarded before submission. Protected merge, exact installation and live report readback remain separate requirements.
