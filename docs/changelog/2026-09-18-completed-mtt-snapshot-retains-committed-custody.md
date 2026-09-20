# Completed MTT snapshots retain their committed custody

The legacy dealer could complete its preflop snapshot before an atomic hand
request was accepted. Early Bird hand 12636137 hit that sequence after an
original paid-entry custody transfer: the saved stacks plus recorded investments
still matched the unchanged 322,500-chip roster, but the existing mixed
disposition accepted only incomplete MTT snapshots. It could not truthfully
dispose of this started, unaccepted hand.

The additive migration extends that same owner with an explicit
`completed_unaccepted_mtt` boundary. It reads the exact snapshot by primary key,
requires an unchanged original paid-custody receipt and whole roster, validates
the saved stacks and investments, and binds retained card records by hash.
Accepted or later hands, private state, dispatch, retained submissions, orphan
monetary receipts, changed cards, and changed custody all refuse the operation.
The permanent receipt records `aborted_unsettled` with zero credit. Snapshot,
cards, original paid receipt, money and registrations remain unchanged.

The existing operation identity, current lease drain, global/tournament lock
order, original/current generation fences and request-admission guards remain
the only recovery authority. No second RPC, outcome reconstruction, transfer
replay or periodic repair is introduced. The separately owned online snapshot
index must be valid with the exact table/hand contract before installation.

The existing F06 native verification entrypoint runs the new qualification.
Focused PostgreSQL qualification reproduced rejection by predecessor `9a655`,
then verified the successor, existing active-MTT compatibility, unchanged row
contents and transaction identities, rollback, typed refusals, exact replay,
competing operations, accepted-first and disposition-first races, current
protocol-2 request drain, retained-request priority and late generation refusal.
The source contract also selects these inputs for the existing required
accounting check.

Source and isolated qualification do not establish production recovery. An
actual current manager must provide its stopped-dealer custody before the
original operation is invoked; an absent lease is not reconstructed authority.
Installation, protected publication and affected production behavior are tracked
separately by the delivery owner.
