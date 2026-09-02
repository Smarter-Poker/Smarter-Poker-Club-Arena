# Table Management Phase 5: Safety And Certification

## Scope

Phase 5 of 6 covers database and browser certification, operator safety,
accessibility, and hostile-state recovery. Phase 6 scheduling, retention,
performance tuning, and rollout remain deliberately out of scope.

## Before-State Audit

### Change 1: Management Content Loads Must Fail Closed

**Files:** `src/services/TickerManagementService.ts` lines 86-119 and
`src/components/club/ClubMessageManagementPanel.tsx` lines 40-78.

**What existed:** ticker RPC errors were converted into editable defaults, and
a club-message load failure left the blank form enabled after the request
finished. Either path could turn a temporary network or permission failure into
an overwrite of valid operator content.

**What will change:** management reads will distinguish "no saved settings"
from "the authoritative read failed." Editors will remain unavailable after a
failed read and expose an explicit retry path without discarding a successful
previous snapshot.

**Why:** an unavailable authority cannot safely be represented as editable
empty state.

### Change 2: Concurrent Editors Must Not Lose Each Other's Work

**Files:** `supabase/migrations/20260901130000_game_and_ticker_management.sql`
functions `fn_save_game_ticker_settings`, `fn_save_club_identity_messages`, and
`fn_manage_club_announcement`.

**What existed:** all three content mutation paths were last-write-wins. Phase
4 made changes visible across devices but did not stop a second operator with
an older form from overwriting the first operator's save.

**What will change:** revision-bearing management reads and compare-and-swap
mutations will serialize ticker, identity, and announcement edits. A stale
editor will receive a typed conflict, keep its local draft, and be offered an
explicit reload.

**Why:** realtime notification without optimistic concurrency detects a lost
update only after it has already happened.

### Change 3: Hostile Payloads Must Normalize Or Be Rejected

**File:** `src/services/TickerManagementService.ts` lines 55-82 and the ticker
save RPC in `20260901130000_game_and_ticker_management.sql`.

**What existed:** `NaN` speed, arbitrary fonts/colors/source values, blank or
oversized messages, and non-object nested values could enter the client model.
Several PostgreSQL casts could also raise before returning a governed error.

**What will change:** a shared client boundary will produce a canonical safe
model, while the versioned database command will type-check JSON before casts,
whitelist every source/font, bound messages, and reject color combinations that
do not meet the management ticker's text and control contrast requirements.

**Why:** local cache, network payloads, and direct RPC callers are all hostile
inputs.

### Change 4: Dialogs Must Behave Like Dialogs

**File:** `src/pages/GameManagementPage.tsx` lines 82-305.

**What existed:** the edit form did not declare a dialog role, and neither the
edit dialog nor contract-history dialog trapped focus, closed with Escape, or
restored focus to its trigger. Cross-field numeric errors were deferred to the
server and surfaced only as a toast.

**What will change:** both dialogs will use the repository focus-trap and Escape
contracts, expose names/descriptions, lock body scroll, restore trigger focus,
and give edit validation an inline live error associated with the form.

**Why:** WCAG 2.1 AA requires keyboard operability, predictable focus, semantic
name/role/value, and programmatic error identification.

## Verification Status

## Implemented

- Added version columns and compare-and-swap commands for ticker settings,
  club identity messages, and announcements. The old mutation functions are no
  longer executable by browser roles.
- Serialized first-time ticker creation with transaction advisory locks so two
  simultaneous revision-zero writers cannot race through an absent row.
- Added command-boundary JSON type checks, bounded arrays, decoded text
  validation, canonical whitespace, font/source whitelists, hex-color checks,
  and WCAG contrast enforcement.
- Changed management reads to fail closed. A failed authoritative read locks
  the editor and exposes Retry without converting the failure into writable
  defaults.
- Preserved local drafts on realtime updates and stale-revision conflicts.
  Loading a newer revision now requires explicit discard confirmation.
- Added request epochs to the page and both content panels so late responses
  from a previous route, scope, or host club cannot repaint the current UI.
- Protected dirty drafts across section changes, union host-club changes,
  reloads, tab closes, hamburger links, and other in-app navigation.
- Upgraded edit and contract-history dialogs with modal semantics, focus trap,
  Escape handling, focus restoration, body-scroll locking, inline validation,
  and discard confirmation.
- Added visible focus states, 44-pixel controls, forced-colors support,
  reduced-motion handling, responsive layouts, explicit labels, counters, and
  accessible live status/error regions.

## Verification Evidence

- PostgreSQL grammar: migration parsed successfully with `pglast` as 32
  statements.
- Focused Phase 5 tests: 33 checks across service hostility, database laws,
  content-panel races/conflicts, dialog behavior, and page wiring.
- TypeScript, targeted ESLint, title-case, painted-text, and diff-whitespace
  gates passed.
- Full repository tests and production builds are recorded in the phase commit
  after the final upstream merge and verification run.

The migration is committed for the normal deployment pipeline. It was not
applied to a local, staging, or production database during this phase.
