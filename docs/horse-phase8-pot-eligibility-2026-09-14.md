# Exact pot eligibility without repeated serialization

Phase 8 repeatedly calls the canonical pot calculator while pricing funded future hands and hypothetical calls. A current-source CPU profile attributed 12.4% of sampled time to `calculatePots`; its hottest recorded line serialized both adjacent eligibility arrays. The profile includes instrumentation overhead and is diagnostic evidence only.

The calculator now counts contributors and collects eligible IDs in one pass per investment level, then compares adjacent ordered ID arrays directly. It preserves every investment level, amount calculation and summation order, folded excess, individual/shared ante rights, seat order, and separate side-pot eligibility. There is no change to trial counts, payout curves, continuation policy, work deadlines, confidence bounds or activation. This same pure calculator is also used by real settlement, so its historical-output and complete-hand checks are mandatory.

## Verification

The frozen reference is `2040e250b8c68ebd3848ac2c3bf4a05de6b2efad`. Six compiled modules preserve its complete pot-to-continuation call path; other imports resolve to unchanged compiled dependencies. The later protected merge `f7b928c0d519838f718edc2c223aaf0f8d290237` has identical server source. No dependency tree was copied and no production hands were generated.

- Native historical comparison: 50,000 pot partitions and 45,454 hypothetical call amounts match exactly. Inputs cover zero through ten seats, folded excess, individual/shared antes, optional contribution fields, cent-rounding boundaries, unusual string IDs and defensive non-finite inputs. All input seats/card arrays are frozen.
- Funded-hand comparison: 5,832 complete outcomes and 5,616 caller-visible draw caches match exactly, including lazy/prepared facts, supported/fallback sample indices, three ante modes, stack patterns and immutable remote coordinates.
- Both counterbalanced performance runs match all 36 complete Phase 7 and Phase 8 decisions. Each run alternates adjacent reference/candidate calls, uses 20 warmups and 100 measured calls per population and clock mode, and prepares both fact caches. The second run reverses the initial order.
- Server compilation and the full 11,992-test suite pass with 145 existing skips. The 70 focused checks include 11,000 complete randomized conservation hands. Three additional explicit fixtures protect adjacent eligibility merges, folded excess and shared-ante-only rights.

| Run                        | Real-clock completion, reference to candidate | Fixed-work worst p99, ms | Real-clock worst p99, ms | Median population p50, fixed work, ms |
| -------------------------- | --------------------------------------------- | ------------------------ | ------------------------ | ------------------------------------- |
| Initial                    | 3,067 to 3,079 of 3,600                       | 8.162 to 7.397           | 4.749 to 4.426           | 2.458 to 2.188                        |
| Reverse-order confirmation | 3,076 to 3,080 of 3,600                       | 7.615 to 7.066           | 4.247 to 4.367           | 2.477 to 2.207                        |

The second run's real-clock worst p99 is worse, even though typical fixed work is about 11% faster in both runs. Some populations still exceed 4 ms, and completion gains are small. Derived 200/1,000-player Spin cases are stress inputs, not supported production configurations. This is a bounded allocation improvement, not Phase 8 performance certification or strength promotion.

The first actual-controller fixture completed all six objectives with legal actions, conserved chips and individually accepted software-baseline receipts. Its overall source-identity check failed because the owned patch was moved from the pre-merge commit onto protected main while the fixture ran. A full server-source comparison confirms unchanged bytes, but that does not override the harness's failed identity receipt. The complete original run is retained; a stable-reference verification is required. The outer Phase 8 receipt limit is 5 ms and its work budget is 4 ms; passing the former does not establish the stricter remaining performance target.

Reproducible native scripts, source hashes, complete timing arrays, full/targeted logs, both controller outcomes and the failed first identity receipt are retained in the task's `horse-brain-continuation-latency` evidence archive. Protected CI, merge, served engine identity and natural operation are separate release facts. Full Phase 8, natural domain coverage and strength acceptance remain open.
