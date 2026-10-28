# Lightning zero-chip seat expiry

Scope: remove a Lightning player after a fixed 20-second unfunded rebuy decision; preserve paid pending chips and live hands. Owner also authorized removing Lucky from all current seats and freeing SSD space.

Owner: chat 01a18352; branch fix/lightning-rebuy-expiry-01a18352; checkout /Volumes/SmarterWork/agent-work/lightning-rebuy-01a18352/source.

Policy read 2026-10-28T16:23:21Z: version 2.9; manifest a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b. Canonical OWNER b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349; OPERATING a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5; HARDENING d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e; INDEX adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555. Read canonical policies, storage guide, repository AGENTS/CLAUDE/playbook, publishing and deploy-paths. Base ecf65a7a2fffb3f80b0a6a1ead6d538249cdb033.

Production repair: rollback probe verified both Lucky original occupancies could exit through fn_cashout_seat_occupancy with zero cashout, then resolve_pending_addon refunded the paid 400-chip PLO4 rebuy. Committed together at 2026-10-28T16:27:55.741838Z; readback confirmed both left_at values, no remaining active seats, and refund receipt amount 400/applied 0. No raw seat deletion or wallet edits. Unrelated historical 200-chip pending row was not changed.

Storage: September World Hub copies with broken Git links and no file changed in 3+ days archived byte-for-byte under /Volumes/SmarterArchives/agent-evidence/lightning-rebuy-01a18352/storage. SHA256 verified each regular file and symlink targets before removing each source. Manifest verified-archive.jsonl. Active worktrees preserved.

Cause: parked Lightning anchors bypassed ordinary busted-player removal and pending-add-on delivery. Ordinary rebuy heartbeat grace could also renew indefinitely.

Acceptance: fixed 20s Lightning deadline independent of prompt heartbeat; funded/paid pending seats retained; zero-seat expiry runs on both parked paths; maintenance time excluded; cashout failure retains tracking; retained regression checks. Engine activation remains subject to certified provider route.

Validation: original Dealing source fails 9 of 15 new regression cases (archived regression-before.log); repaired source passes all 15. Eight focused engine/maintenance files pass 161 tests. Root and server tsc --noEmit pass. Policy check --canonical passes. The clock is process-local and excludes maintenance in memory; a fresh engine conservatively grants a fresh decision window rather than consuming restart downtime. No database deadline or schema migration is introduced. Engine source publication and live feature proof remain pending.
