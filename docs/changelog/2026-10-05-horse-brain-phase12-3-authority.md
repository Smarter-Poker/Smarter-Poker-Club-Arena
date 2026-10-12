# Horse Brain Phase 12, P12.3: Short Deck, Pineapple, FLH and FLO8 can be admitted only through the qualified authority path, one pack at a time

Each Phase 12 pack (`short-deck-round1-v2`, `crazy-pineapple-round1-v2`,
`fixed-limit-holdem-round1-v3`, `fixed-limit-omaha8-round1-v3`) now has its
own protected release selection, its own admission and its own main-scheduler
gate, all on the Phase 8 authority path that P11.3 reused for PLO5, PLO6 and
PLO8. All four selections are `null`, and admission answers `unselected`
before it reads any file, so every live Phase 12 decision stays in shadow and
executes exactly what it did before (pinned on twelve live worker states
against the unmodified base). The only live difference is that each Phase 12
receipt now records its pack's authority receipt (`unselected`) and its
selection outcome.

Admission of a pack requires its P12.2 `horse-phase12-qualification-v1` file
with exactly the assembler's keys (contract mode, cash objective measured and
qualified at the contract's margin, no failure reason, the running contract
digest, the running pack's policy digest recomputed from the running code, the
selected source, the strength record's hash) and a natural completion record,
`horse-phase12-completion-v1`, defined here to meet the P12.2
`admissionAlsoRequires`: every street's share of eligible cash betting
decisions that completed must clear 0.95 on its 99% Wilson lower bound (at
least 127 decisions per street). Not completed: the 4 ms work-budget fallback,
a sample the 2.5 ms deadline cut short, a postflop decision with no live sample,
and (new, the Phase 11 audit's correction) a sample the equity governor reduced
below the full 32. Tournament decisions and every Pineapple discard are never
counted. A selection, file, record, holder or receipt of one pack, or of a
Phase 11 pack, never admits another.

Wired as P11.3 wired Phase 11: worker-owned mode (cash only, the decision's own
pack only; tournaments stay with Phase 7), the caller can still only turn the
packs off, per-pack worker receipts on FAST and DEEP results, client mirror,
stamp and effect recheck at the deciding pack's gate, the acceptance-time
verdict and withdrawal before acceptance in `ServerTableEngineTurns`, a
controller refusal withdrawing that pack only, the P12.2 `illegal_candidate`
guard kept for a live admitted candidate, worker-boundary validation, the
witness `phase12Authority` binding, journal coherence, and
`phase12_selection_*` / `phase12_authority_*` telemetry.

The completion reader is built and tested on real policy receipts:
`server/scripts/phase12-completion-extract.py` (host, read-only, closed
sha256-named segments, discards counted apart) and
`server/src/scripts/phase12CompletionRecord.ts` (counts with the authority's
own function; the release's digest from `git show`). It has not read a host
journal; natural completion is implemented but unverified until a release has
served a predeclared window.

Also: the P12.2 selection-guard test now pins zero natural `illegal_candidate`
refusals (P12.1's legal form fixed the cents/whole-dollar defect before any
held-out run), and the P12.2 record says so. P12.3 changes three hashed policy
files, so the Phase 12 policy digests move: the held-out matrices must run on
a source that contains P12.3.

Tests: 231 new (authority 129, completion reader 17, owner-level selection 13,
worker 30, client 9, effect commit 11, witness 4, journal 17, assembler 1). 35
touched and reused suites: 1,543 pass; the one failure is the unrelated Phase
11 null-proof test, which fails identically on the base. Record:
`docs/horse-brain-phase12-3-authority-2026-10-05.md`.
