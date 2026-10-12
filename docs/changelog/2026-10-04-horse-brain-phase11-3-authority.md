# Horse Brain Phase 11, P11.3: PLO5, PLO6 and PLO8 can be admitted only through the qualified authority path, one pack at a time

Each Phase 11 pack (`plo5-high-round1-v2`, `plo6-high-round1-v2`,
`plo8-split-round1-v2`) now has its own protected release selection, its own
admission and its own main-scheduler gate, all on the Phase 8 authority path
that P10.3 reused for PLO4. All three selections are `null`, so every live
PLO5, PLO6 and PLO8 decision stays in shadow and executes exactly what it did
before (pinned on twelve live states against the unmodified base). The only
live difference is that each Phase 11 receipt now records its pack's
authority receipt (`unselected`) and its selection outcome.

Admission of a pack requires its P11.2 `horse-phase11-qualification-v1` file
(contract mode, cash qualified, the running contract digest, the running
pack's policy digest, the selected source, the strength record's hash) and a
natural completion record, `horse-phase11-completion-v1`, defined here to meet
the P11.2 `admissionAlsoRequires`: on a release with the same policy digest,
every street's share of eligible cash decisions that completed without the
4 ms work-budget fallback and without a truncated live sample must clear 0.95
on its 99% Wilson lower bound (at least 127 decisions per street even when all
complete). Every refusal is named; six completion refusals were added to the
shared vocabulary. A selection, file, record, holder or receipt of one pack
never admits another.

Wired as P10.3 wired Phase 10: worker-owned mode (cash only, the decision's own
pack only; tournaments stay with Phase 7), the caller can still only turn the
packs off, per-pack worker receipts on FAST and DEEP results, client mirror,
stamp and effect recheck at the deciding pack's gate, the acceptance-time
verdict and withdrawal before acceptance in `ServerTableEngineTurns`, a
controller refusal withdrawing that pack only, the `illegal_candidate` guard in
`HorseLogic`, worker-boundary validation, the witness `phase11Authority`
binding, journal coherence, and `phase11_selection_*` / `phase11_authority_*`
telemetry.

Two latent defects fixed (offline-only until authority exists): a
legalizer-rewritten Phase 11 candidate was still reported as applied, and an
applied Phase 11 receipt had no rule at the worker boundary.

Tests: 170 new (authority 94, owner-level selection 13, worker 26, client 8,
effect commit 10, witness 3, journal 15, assembler 1); Phase 10's authority
suites pass unchanged. Not built: the journal reader that writes a completion
record. Record: `docs/horse-brain-phase11-3-authority-2026-10-04.md`.
