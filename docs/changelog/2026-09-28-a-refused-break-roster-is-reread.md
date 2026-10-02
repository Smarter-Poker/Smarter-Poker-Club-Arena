# A refused break roster is re-read, never re-sent (2026-09-28)

## What Dan saw

The MTT release certificate could not find one tournament table with three or
more players dealing. The big freerolls kept their players, but every table
held one player. At 03:52 UTC: `618741a5` "$100 Freeroll 12:00 PM" 28 tables /
28 seats, `ac10f59a` 27/27, `c775d008` 26/26, `72e595f4` 29/30, `700df3bc`
"Sunday Funday Mystery" 10/10, and ten more events the same shape.

## What the rows say

A lone-table event only consolidates through F06 table breaks: park the
source, begin a manifest naming its whole roster, move each member, retire.
Measured on 2026-09-28:

- `700df3bc`: ten tables, one live seat and one `playing` registration each.
  Three breaks open. Break `cf0e43f3` (source `c04d29c0`, "Table 7") was
  requested at 03:28:49 while a two-player hand was still running; that hand
  ended at 03:29:01.68 and busted `ae0bc48d` (bust recorded 03:29:01.95).
  From then on the engine logged `Tournament.break_recovery_unresolved:
  F06 fn_f06_begin_break outcome unproven: F06_WHOLE_ROSTER_REQUIRED` for that
  break on every visit (03:34:59, 03:46:02, ...), still `park_requested`,
  revision 0, manifest NULL at 04:10.
- The door's whole-roster test (`fn_f06_begin_break`, line 24) compares the
  proposal's length with the source's live seats and its `playing`/`registered`
  registrations. `c04d29c0` held exactly one of each for the whole period, so a
  one-member proposal passes it. The proposal being re-sent therefore named
  more players than the table held.
- The same refusal, repeated, on eleven breaks in nine events between 03:20 and
  03:51 (`700df3bc`, `70177ba2`, `ac10f59a`, `dce543d3`, `e82c9273`,
  `5710b946`, `e6fc7114`, `b9256be8`, `a33b4c5e`, `a2948a11` among them),
  e.g. `98583619` (`70177ba2`, source `6364fe71`: one seat, one registration,
  no seat change after the park) refused at 03:31:58 and 03:43:26.

## The line

`prepareParkedTournamentBreak` begins with

```ts
const retained = this.pendingTournamentBreakBegins.get(state.break_id);
if (retained) return this.beginTournamentBreak(state.break_id, state.source_table_id, retained);
```

`pendingTournamentBreakBegins` exists so that a LOST reply is replayed with
the same identities. But `beginTournamentBreak` stored the proposal before the
call and only released it on success or on the correlated capacity refusal.
A whole-roster refusal was reported as "outcome unproven" and the proposal
stayed, so the next pass replayed it before reading any seat, and got the same
refusal, for as long as the process lived. While the operation exists its
source is excluded from every other plan (`loadBalancerTables`,
`f06_validate_destination`), so that table's player could never be merged.
The capacity path had the same trap one level up: a capacity-rejected proposal
pinned its membership (`assertBreakMembership(rejected, exact)`), so a bust
after a capacity race made every later begin throw before reaching the
database.

`prepareParkedTournamentBreak` also ended in a dozen guards that answered a
bare `null`, and `recoverTournamentBreak` turned that into silence, which is
why the other stuck parks (`5c2afde4`, `a81be011`, `271984b8`) left no line
saying why they did not begin.

## The fix

- `TournamentTableBreakRpc` throws `TournamentTableBreakRosterChangedError` for
  exactly `fn_f06_begin_break` + (`22023`, `F06_WHOLE_ROSTER_REQUIRED`) or
  (`55000`, `F06_SOURCE_NOT_EXACT`). Both are RAISEs the door reaches only
  after finding the manifest NULL under `FOR UPDATE`, so the refusal proves
  nothing was begun. Every other error keeps meaning "outcome unproven".
- `beginTournamentBreak` answers that error through
  `releaseRefusedBreakRoster`: reconcile; if the operation is still an unbegun
  park, the proposal moves to the resolved-proposal history, leaves pending and
  rejected, and a balance re-drive is requested. Anything else is asserted as a
  manifest this manager sent.
- `prepareParkedTournamentBreak` re-reads the roster in the same pass when the
  replay was released, instead of waiting for the next visit.
- A capacity-rejected proposal whose membership no longer matches the roster
  moves to history instead of throwing; request identities of players still
  seated are reused exactly as before.
- Reconciliation adopts a begun manifest that matches ANY proposal this
  manager sent (pending, capacity-rejected or refused), so a delayed commit is
  still adopted, and still refuses one it never sent.
- Every guard in `prepareParkedTournamentBreak` names itself
  (`lastBreakPreparationRefusal`, one `Break xxxxxxxx not begun: <reason>`
  line per change).

No database change. No money moves: the fix changes which roster the engine
proposes, and the door still checks every seat, stack and registration.

## Pinned by

`server/src/tournament/aRefusedBreakRosterIsReread.law.test.ts`
(`docs/laws.d/a-refused-break-roster-is-reread.md`).

## Still open

- How the engine first built a proposal naming a player who had already left
  is not proven. The candidate is the park being claimed across the end of the
  running hand; the new refusal names and the fix make it harmless either way.
- Breaks that are not refused still take 20 to 45 minutes each on lone-table
  events (`8faabcb4`, 03:22 -> 04:04 for one player), with
  `retirement_custody_stale` and `table_engine_never_ready` on the way. The
  refusal names added here are how the next pass is measured.
