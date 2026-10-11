# Four Cashier database fixes

Four small database corrections found during the Cashier launch audit. Each one
replaces a single function body, refuses to run unless production still holds
the exact body it was written against (md5 guard), checks its own result inside
the same transaction, keeps every grant as it was, and is qualified by its own
PostgreSQL 17 harness that fails on production's current body and passes on the
new one. Horses and human players follow the same rules in all four.

## A chip request can still be approved after one approver is refused

`20261010003544_a_chip_request_approval_key_belongs_to_its_approver.sql`
(`fn_respond_chip_request(uuid,text)`, f6b8bf0d... to 10fb3a12...).

When an agent with no float tried to approve a player's chip request, the send
was refused, but its retry key was made from the request alone. Every later
approver (the owner included) then hit the same key and was refused too, so the
request could never be approved by anybody. The key is now the request plus the
approver. An approval made under the old request-only key still replays for its
own approver and never pays twice.

## A union send to a different member is paid, not swallowed as a duplicate

`20261010004314_a_union_send_is_suppressed_only_as_a_retry_to_the_same_membe.sql`
(`fn_union_send_to_member_zd3core(uuid,uuid,text,numeric,text,text)`,
fcb71e70... to b90deb83...).

A union sending the same amount to a second member within 20 seconds was told
the send succeeded, and nothing moved. Duplicate suppression now also matches
the recipient and the kind of send, so only a true retry to the same member is
suppressed. The union still pays exactly what it sent.

## Cashier lists name members by their arena name

`20261010005048_a_cashier_list_names_a_member_by_the_arena_name.sql`
(`fn_club_trade_ledger(uuid,integer,integer)`, ea5a5a57... to d489a8b9...;
`fn_agent_wallet_reversible(uuid)`, 61b3478f... to 3cc86bbb...).

The Claim Back list printed the World Hub name instead of the poker alias, and
the Trade record put the display name ahead of the username. Both now use
`fn_arena_name`, the same naming every other Club Arena screen uses. The rows,
their order and every other column are unchanged.

## A suspended agent stops reading the club finances

`20261010010632_a_suspended_agent_stops_reading_the_club_finances.sql`
(`ca_can_view_club_finances(uuid)`, fae59a34... to 20d50957...).

The gate in front of the club finance reports and two audit policies still
admitted a super agent the club had suspended, one whose agent row belongs to
another club or is missing, and an admin whose membership is still pending. It
now uses the Cashier's own "active member" rule. Every current staff member
keeps access, and the database's own sessions (the installer and scheduled jobs)
are still admitted.

## Regression protection

- Harnesses: `scripts/ci/test-chip-request-approval-db-postgres.py`,
  `test-union-send-db-postgres.py`, `test-cashier-arena-names-db-postgres.py`,
  `test-finance-gate-db-postgres.py`, with fixtures under `tests/fixtures/`.
  Each reproduces production's live body byte for byte, shows the scenario
  failing on it, installs the migration, shows it passing, and shows a replay
  is refused.
- CI runs all four in `accounting_postgres` shard 2; `classify-ci-changes.mjs`
  has a `cashierDbHarnesses` selector so an edit to a harness or fixture alone
  still runs that job (pinned by `tests/unit/cashier-db-harnesses-ci.test.ts`).
- Law tests: the four `tests/*.db.law.test.ts` files and their `docs/laws.d`
  entries.
- `scripts/verification-harness/cashier-release-contract.sql` accepts the
  post-install body of `fn_respond_chip_request`, `fn_club_trade_ledger` and
  `fn_agent_wallet_reversible` as `replacement_hash`; an unknown third body still
  fails closed. After installation a follow-up makes the new body the `hash`.
- Source bindings for `classify-ci-changes.mjs` and `ci.yml` were restamped
  (`cashierDbHarnessesRouting20261011`).

## Installation

Nothing in production changes with this merge. After merge, dispatch the
existing **Apply Merged Migration** workflow once per file, in version order:
20261010003544, 20261010004314, 20261010005048, 20261010010632. Each file's
`-- @live-proof:` line must read true afterwards. Never re-dispatch an installed
file.
