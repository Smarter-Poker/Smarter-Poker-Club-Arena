# A treasury-funded seat reads as a Club Bank send, on the server too

When the club treasury pays a horse's seat, the receipt is a
`horse_treasury_funding` row with a note that says horse, and its journal leg
is a `horse_funding` leg whose description ends in the horse's user id. The
Trade record and ledger screens already print these rows as "Club Bank To
<alias>" (#6677), but the database reads still handed the horse kind, the horse
note and the user id to anyone who called the API. This change fixes the reads
themselves. Owner decision, binding: horses are indistinguishable from people.

Migration `20261012040542_a_treasury_funded_seat_reads_as_a_club_bank_send.sql`
(not installed by this change; it was drafted as `20261010022900` and
re-reserved so it sorts after everything already on main):

- **Trade record** (`fn_club_trade_ledger`): a funded seat is kind
  `club_bank_send`, from the Club Bank (no sender id or name), metadata only
  `{"destination": "player_wallet"}`, no note, the recipient by arena name.
  Every Club Bank send now reads the same way to a viewer who is not part of
  it. The operator still sees their own send as theirs and the member paid
  still sees who paid them, as decision 2 requires. This also keeps the Trade
  record's In and Out totals from moving. A typed reason is kept; the stock
  "Club Bank Send" note and any note mentioning a horse are dropped.
- **Club Bank ledger** (`fn_club_bank_ledger`): the same rows, and the type
  list, type filter and count treat a funded seat as a Club Bank send, so the
  filter no longer offers a horse kind. The into/out/net figures are unchanged.
- **Treasury statement** (`fn_ca_chip_statement_page`, `fn_ca_chip_statement`):
  a funded seat's leg prints as `table_funding` with no description.

Every row is kept: same rows, order, pages and totals. Grants, SECURITY
DEFINER, search_path and lock_timeout are unchanged. The file refuses to run
over any body other than production's current one, and refuses a replay.

Checked and not leaking: `fn_agent_wallet_reversible` (agent wallet sends only)
and `ca_club_member_detail` (aggregates only). `fn_my_wallet_ledger` returns
the raw kind, but only to the account it belongs to.

Verification: `scripts/ci/test-horse-reads-db-postgres.py` (PostgreSQL 17,
production's live bodies reproduced byte for byte, including the helpers as
20261010010632 and 20261010190307 leave them). On the live bodies, exactly the
13 horse-related checks fail; after the migration all 18 pass, and only the
expected cells change. It now runs in `accounting_postgres` shard 2.
`cashier-release-contract.sql` accepts the live and the post-install bodies.
