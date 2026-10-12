# Horse Brain Phase 14.4 (plan package P14-D, inactive slice): corrective candidates are bound, catalogued and kept inactive (2026-10-07)

Corrective review references and authorities are now bound to the variant,
format and mode of the decision they judge. Reviewed candidates can be gathered
into an inactive catalog with a separate holdout. Phase 14 has the same
per-domain authority shape as Phase 13, with every selection null. Nothing
became active. Record:
[horse-brain-phase14-4-inactive-admission-2026-10-07.md](../horse-brain-phase14-4-inactive-admission-2026-10-07.md).

- **Contract and authority**: references and authorities are version 2.
  References carry domain, evidence class, sampling contract digest and
  producer digest. The signed authority carries approval generation, expiry and
  domains, under the signed message `horse-corrective-review-authority-v2`.
  Version 1 envelopes are refused, not reinterpreted. The reviewer refuses by
  name an uncovered or mismatched domain, an expired authority, an invalid
  generation, and synthetic evidence mixed with reviewed evidence anywhere.
- **Inactive catalog** (`horseCorrectiveReview/candidateCatalog.ts`): stable
  ids from each candidate's binding, disjoint selection and holdout windows
  (`holdout_leakage`), a finite selection protocol declared before validation
  (`selection_window_reused_as_validation`), complete per-domain baseline
  distributions (`incomplete_policy_distribution`), and a catalog digest. Every
  entry is `proposed_inactive` with `activationAllowed: false`.
- **Admission** (`engine/HorsePhase14Authority.ts`): 45 null release
  selections, one Phase 8 holder and gate per domain, and refusals for catalog
  and holdout digest mismatches. No decision path imports it.
- **Why nothing activates**: no qualified reference producer, independent
  signer or decision-time corrective applier exists. None was created here,
  because creating one from this repository would be self-qualification.
- **No database or migration change.**
- **Tests**: 22 files, 1058 tests across the corrective, daily, regression and
  authority suites; Phase 10 to 12 authority suites 273; `tsc` clean.
