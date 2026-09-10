# A Level Keeps Its Advertised Duration And Its Overdue State

The current manager and client both reset a persisted level to its full duration when its anchor was at least four durations old. The manager now keeps that level due at its existing one-second scheduling minimum; the client shows zero without inventing another level. Recorded synchronized-break time is still excluded by the existing recovery owner. This does not change the first-deal hold or manufacture a catch-up sequence.

The generic overflow resolver applied acceleration while building a derived row, then the timer applied it again. An advertised ten-minute tail became three minutes instead of five; a five-minute tail became two instead of three. The resolver now carries the raw advertised duration and the timer applies acceleration once. Valid durations below two minutes are preserved instead of being replaced by an unbooked two-minute minimum. Blind amounts, caps, rounding, Spin receipt producers and entry-closure decisions are unchanged.

## Executed Evidence

The added regressions ran first on unchanged main `904171acc4f143da4c8c6619ba73cfbc12293753`. They reproduced three client overdue failures, four manager overdue failures and 27 duration-composition failures. The corrected source passed 148 server assertions across eight files and 118 client assertions across three files. Client and server TypeScript checks exited zero. Exact raw logs and source hashes are in `evidence.json` and the adjacent files.

The duration matrix executes the actual extracted manager methods with the real escalation, acceleration, ladder and Spin helpers. It covers all three duration spellings, 0.5/1/5/10/15-minute rows, acceleration on/off, entry open/closed, persisted rows, overflow after a trailing break row, repeated reads of frozen structures and three-minute Spin continuation. The actual restore-method regressions cover the exact four-duration boundary, later recovery, a day-old anchor and restoration inside a recorded break. These are bounded JavaScript composition tests, not production financial or full database clock ownership proofs.

The booked-Spin compatibility extractor now includes `rawLevelDurationMs` when the selected source version defines it. Historical source pins that predate this method remain supported.

## Canonical Clock Work Still Open

K01 remains open. The archived prospective components at `831f408db7eb593abe5a0d108177c382adfb19e2` are preserved and were not activated. The following owners still need complete implementation and execution evidence:

| Owner                       | Remaining Work                                                                                                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public Clock Operations     | Implement atomic adopt, initialize, advance, pause and resume with immutable request/outcome receipts, a separate fresh snapshot, exact lease/freeze rechecks after waits and durable activation authority.             |
| Table Membership            | Serialize insert, reopen, close, delete and both sides of event reassignment; derive canonical blinds under activation and prove whole paid-capacity rollback with actual current owners.                               |
| Local And Maintenance Pause | Bind exact immutable epochs to public local pause ownership and current maintenance snapshot/checkpoint/suffix/thaw owners; credit the union once and preserve already-open pause adoption and future release tails.    |
| Manager Adoption            | Retire detached startBlindTimer anchor writes and per-table advance fan-out; adopt only committed revisions, retain operation UUIDs after ambiguous transport, and fence delayed continuations before dealer admission. |
| Browser Adoption            | Read the accepted effective duration/entry-closure decision and canonical deadline, including pause and maintenance revisions. The current client cannot infer immutable epoch facts from a later closure flag.         |
| Rolling Publication         | Verify the complete current manager/client/database composition, actual production lock graph, normal coowner engine adoption and live table/level/anchor agreement.                                                    |

Current main includes the coowner's tournament maintenance-thaw restoration. The separate per-tournament lane work changes the production G/T lock contract and must be recaptured before any new clock SQL integration. Earlier G/B/T fixtures are not current production proof. No host, container, engine release, cutover seal, production SQL, horse strategy or balance was changed in this patch.
