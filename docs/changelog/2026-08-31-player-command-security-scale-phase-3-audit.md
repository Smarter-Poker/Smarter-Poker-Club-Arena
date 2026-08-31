# Player Command — Security & Scale Audit (Phase 3 of 6)

## Outcome

Phase 3 re-audits and hardens the role-shaped Player Command contract on the
current Phase 2 release. It closes cold-render virtualization, note-save
idempotency, capability parity, cursor isolation, literal-search, and export
input gaps while reducing work for redacted viewers.

## Client

- The virtual roster now attaches its scroll listener when a cold load changes
  from no viewport to a populated viewport. Large rosters no longer freeze on
  the first rendered slice.
- Search input is bounded to 120 characters in both the UI and service.
- Staff can select or clear every loaded player directly from the toolbar; the
  action is keyboard accessible and exposes pressed state.
- Member notes now have explicit Save and Revert controls, visible saved/dirty/
  saving state, serialized blur saves, and protection against a completed
  request clearing the dirty state of newer text.
- The note editor is keyed to the target member so an in-flight response cannot
  bleed into a member opened immediately afterward.

## Server contract

- Cursor v2 is bound to the actor, club, normalized search, filter, and sort.
  Reused or hostile cursors restart from page one instead of skipping rows.
- Search is bounded and uses literal substring matching, so `%` and `_` are
  ordinary search characters rather than wildcard controls.
- Invalid export filters and sorts normalize to the documented contract, and a
  selected export is bounded to 5,000 IDs per audited request.
- Ordinary players skip recursive hierarchy work. Wallet and lifetime-fee
  joins run only for rows whose role-shaped access decision permits them.
- Live-seat lookup is split into indexable home-club and table-club branches;
  a production parity query proved the new set exactly matched the old set.
- Idempotent note replays return the complete persisted nickname/remark payload
  and do not create a second audit row.
- Note self-edits are rejected server-side, matching the existing
  `can_edit_notes=false` response for the target actor.

## Production proof

- Applied migrations:
  - `player_command_phase3_security_scale_hardening`
  - `player_command_note_capability_parity`
- Live SHARK CLUB role simulation:
  - owner: 80 of 80 returned rows carried authorized financial fields;
  - ordinary player: 0 of 80 rows carried financial fields;
  - non-member summary access was denied;
  - ordinary-player export and self-note editing were denied;
  - stale cross-sort cursor restarted correctly with cursor version 2;
  - literal `%` search returned zero matches instead of the whole roster.
- A transactional note proof returned complete first/replay payloads, wrote
  exactly one audit row for the duplicate request, and then rolled the note and
  audit mutation back. Production data was unchanged.
- Warm live default-page probes returned 80 rows in 0.465 seconds for the owner
  and 0.210 seconds for an ordinary player during the verification window.

## Visual direction

No new hero artwork was introduced. The existing roster-ledger composition is
unique to Player Command; this phase adds distinct physical-console behavior
through the gold selection control and audited note console rather than
repeating another near-identical casino image.

## Verification

- Client: 729 test files and 10,235 tests passed.
- Server: 274 test files and 3,085 tests passed.
- TypeScript, changed-file ESLint, changed-file Prettier, and diff-integrity
  checks passed.
- The client production dependency audit reported zero vulnerabilities.
- Production role, cursor, search, export, note-idempotency, grant, and live-seat
  parity proofs passed after both migrations were applied.
