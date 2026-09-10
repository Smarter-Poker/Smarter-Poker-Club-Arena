# Played Spin Recovery Requires A Real Hand Count

## Existing Behavior

`server/src/tournament/playedSpinLaunchRecovery.ts` accepts the database proof for the narrow three-paid-player Spin recovery with one busted seat. Its hand evidence check used `Number(value.hand_count) < 1`. Missing and nonnumeric values become NaN, and positive infinity, fractions, booleans or singleton arrays can pass that comparison. A malformed proof could therefore activate played-game recovery without a valid persisted-hand count.

The caller is `TournamentManagerBase`: it uses `parsePlayedSpinLaunchRecoveryProof` before admitting the special two-active-player launch path. Ordinary heads-up SNG and new Spin launch rules remain separate.

## Intended Correction

Require the JSON hand count to be a positive safe integer number before accepting the played-game proof. Preserve all payment, entitlement, exact identity and chip-conservation checks. Add malformed transport-shape regressions alongside the existing zero-hand refusal and a valid multi-hand case.

## Verification

Before correction, ten adversarial receipt regressions failed. After correction, all 27 parser cases and the broader 170-test Spin/launch selection passed. Full server TypeScript passed with no emission. The compact PostgreSQL funding proof passed 42 checks; its atomic authority definition matches production, while later lower money-function composition remains explicitly open. See `docs/audits/2026-09-10-accounting-phase-three-spin-swarm.json`. This is an engine proof parser correction, with no database migration, financial mutation, historical adjustment, hardcoded tournament exception or polling job.
