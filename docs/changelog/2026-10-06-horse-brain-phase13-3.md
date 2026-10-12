# Horse Brain Phase 13, P13.3: joint multiway authority, policy digest and completion reader (2026-10-06)

The joint multiway owner can now be admitted per variant through the same
worker-owned authority path Phases 8, 10, 11 and 12 use. Nothing is selected:
all nine entries of `PHASE13_PROTECTED_RELEASE_SELECTIONS` are null, so every
live joint decision stays in shadow exactly as before, and a caller still
cannot ask for candidate mode. Record:
[horse-brain-phase13-3-authority-2026-10-06.md](../horse-brain-phase13-3-authority-2026-10-06.md).

- **Authority** (`HorsePhase13Authority.ts`): one holder and one gate per
  variant, bound to `joint-multiway-round1-v4/<variant>`; qualification schema
  `horse-phase13-qualification-v1` (the Phase 12 sixteen keys), the Phase 12
  refusal order, contract digest from `jointStrengthContractDigest()` and
  policy digest from `horsePhase13PolicyDigest(variant)`.
- **Wiring**: worker admission and mode, receipt validation at the boundary
  (`horsePhase13SelectionIsValid`), client refresh, stamp, effect recheck and
  forget, acceptance-time recheck and withdrawal at the table, witness
  `phase13Authority`, reviewer reconciliation, ledger rows. The
  `earlier_phase_applied` guard is covered on the authority path.
- **Policy digest** (`horse-phase13-policy-digest-v1`): 32 hashed files, 12
  excluded closure files with reasons, a TS-parser closure test.
- **Natural completion share** (`horse-phase13-completion-v1`,
  `horse-phase13-completion-definition-v1`): per street and per board count,
  floor 0.95 on the Wilson lower bound at the contract z, at least 127 eligible
  decisions per cell; two-stage reader `phase13-completion-extract.py` and
  `phase13CompletionRecord.ts`.
- **Root fix**: `multiway/JointDeductions.ts` imported its pot-scaling helpers
  from `HandController.ts`, which pulled the controller and the database
  client into the joint owner (a 125-file closure instead of 42). The helpers
  moved unchanged to `WinnerUnitScaling.ts`; `HandController.ts` re-exports
  them.
- `JointStrengthContract.ts` here is a compile stub with the agreed exports;
  the P13.2 file replaces it at merge.
