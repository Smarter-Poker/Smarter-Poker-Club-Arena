# Phase 3 S09 Every-Tier Rule Acceptance

Original S09 requirement:

> Apply multiplier-specific payout places, starting stack and levels. Test every probability tier, not only the common result.

## Authorized Rule Supersession

The later board-stack ruling recorded in [the Spin specification](../../src/config/spinSpec.ts) explicitly supersedes multiplier-dependent stacks. Dan's September 1 rule gives Turbo boards 300 chips and Deep Stack boards 1000 chips at every multiplier. All tiers share three-minute levels. Payout places still depend on the selected tier. This review preserves the original requirement and applies that documented supersession; it does not restore the retired stack bands.

## Verified Result

On 2026-09-10, **16 PostgreSQL scenarios passed**, covering all eight actual probability tiers at both approved board stacks. **All 16 resulting database receipts also passed the real engine receipt consumer.** The previous 58-check funding/recovery rehearsal was not rerun.

| Multipliers    | Payout Percentages | Board Stacks | Level Duration |
| -------------- | ------------------ | ------------ | -------------- |
| 2x, 3x, 4x, 5x | 100                | 300 And 1000 | 180 Seconds    |
| 10x            | 80 / 20            | 300 And 1000 | 180 Seconds    |
| 25x, 50x, 100x | 80 / 12 / 8        | 300 And 1000 | 180 Seconds    |

The new runner calls the actual `spinRuleManifest` function rather than reconstructing its rules in Python. It chooses a point strictly inside each tier's real probability interval, executes the composed atomic draw in a disposable database, and checks the funded prize, unchanged board stack, full blind structure, payout structure, frozen manifest and remaining reserve balance.

For every tier, the real database projection trigger restores the booked rules from deliberately empty projection arrays. A response-loss retry with changed incoming frequencies returns the original receipt and retains one draw. Those exact SQL receipts are then consumed by the actual `readFundedSpinDraw` engine function.

The probability table used by the actual producer contains 10,000,000 frequency units and 27,600,000 weighted units, matching the approved 2.76 expected multiplier and flat 8% rake. RNG is controlled to select each tier; this is not a statistical RNG audit.

## Source And Deployment Identity

| Source                                     | SHA256                                                             |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `server/src/config/spinSpec.ts`            | `5a30cbcc3089da4ae49232d3c50afdcc5f8c787817d39cd9d7361205d1446c54` |
| `server/src/tournament/SpinDrawReceipt.ts` | `2a63498d705aefae65c1d0b3fab754b953b8f3384deb84a5adaf51eae23ab79a` |

The two engine files were also compared byte-for-byte with deployment commit `4d29dce4`, independently verified live by the deployment lane, and match the tested files. The disposable database checks the composed atomic function's definition MD5 `1c911e3ada50ffe0493b9b375e3fa9ae` before any scenarios. It reuses the existing installed SQL fixtures, including the actual played-recovery proof.

## Scope And Reproduction

This closes the previously missing every-tier SQL-to-engine rule check for S09. Controlled funding evidence, ownership and maintenance inputs remain the funding fixture's explicit limits. This does not execute real registration/startup races, seat transition writers, a live hand, or the final payout writer. Those requirements remain with their corresponding Phase 3 controls. No production code or financial data changed, and no deployment is required for this test/evidence commit.

```sh
PATH=/opt/homebrew/bin:$PATH \
POKER_AUDIT_TYPESCRIPT_MODULE=/Users/smarter.poker/Documents/club-arena/node_modules/typescript/lib/typescript.js \
python3 scripts/dev/probe-spin-tiers-pg17.py
```

The optional TypeScript module path reuses an existing installation; nothing is installed or copied. The runner accepts no remote database connection and creates a PostgreSQL 17 cluster listening only on its private Unix socket.

Result artifact: `docs/audits/2026-09-10-phase3-spin-tier-results.json`. Execution output: `/tmp/codex-phase3-spin-tier-run.log`. Database log: `/tmp/codex-phase3-spin-tier-pg17.log`.

The Python runner calls `scripts/dev/spin-tier-runtime.mjs` to compile the two real engine files into one disposable directory, produce their manifests and consume the SQL receipts. Both temporary runtimes are removed after execution.
