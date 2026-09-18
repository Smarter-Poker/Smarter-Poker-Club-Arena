# Original cash funding follows custody

Scope: Union Accounting + Rake Back, migration `20260918032932`. This database-only successor uses the deployed manifest contract; it requires no new engine revision, debit owner, game policy or scheduled process.

The deployed reader lost original buy-ins after legitimate cash seat moves because it searched only the destination occupancy. Read-only production evidence traced all 29 sampled post-capture missing occupancies through exact original move receipts to one captured buy-in, including seven Union occupancies. The successor follows the original player, table and occupancy chain and retains those exact movement receipts in the predeal participant proof. It validates every original debit and refuses forks, cycles, player/amount/identity corruption or unsupported ownership. No membership lookup or timestamp-proximity join attributes money.

Club P&L uses the original funding club, Union and chips asset. A wallet buy-in and treasury top-up from that same club therefore qualify while preserving both original debit ledgers, accounts and entity IDs. Distinct clubs, Unions or assets remain unqualified. This refines the earlier single-account conservative restriction described in the September 17 funding changelog; it does not allocate beneficial ownership, merge balances or authorize another payment.

Each participant proof retains its exact observation cutoff. Hand readers exclude later actual funding records even when their transaction's book frame began earlier. Original movement and funding in the same transaction bind by exact transaction identity. The new projection uses canonical UTC serialization. Weekly boundaries use the existing original book frame; new movement receipts acquire that frame in their owning transaction. Pre-existing movement rows remain unframed and cannot certify a historical weekly boundary. Existing uncertified manifests remain immutable.

The original movement journal now refuses UPDATE, DELETE and TRUNCATE, retaining its existing RLS and private write authority. Existing financial and gameplay owners are unchanged. The migration checks the exact installed definitions, owners and ACLs of the three replaced readers/capture functions before changing them.

## Qualification

The existing full weekly accounting runner now includes `qualify-cash-move-funding.py` in a separate database cloned from its real native prerequisite schema. Its focused `--cash-move-only` mode runs only this connected qualification after prerequisite installation. No existing suite or assertion is removed.

Actual original public move execution and original wallet/treasury funding reproduce both failures before the successor. Afterward, two-hop funding, accepted zero-rake human/horse hands, zero-delta participants, separate same-club debit identities, original replay and no-extra-debit invariants pass. Direct refusal cases cover changed player/amount/debit, a receipt-consistent cycle, destination fork, changed frozen proof, different funding Union, private ACLs and immutable journal operations. New-move boundary holdings retain the original 125-chip wallet-plus-treasury amount, and one-transaction buy-in/move retains its own 100-chip amount. Old unframed moves remain blocked.

A real second connection opens its book frame before hand capture and records a treasury top-up after hand acceptance. The original receipt timestamps prove that ordering; the accepted hand remains certified. Catalog definitions, source/body hashes, owner/ACL/configuration, table columns/defaults/triggers and exact tested source binding are exported from that native database. Native qualification is separate from protected publication, production installation and natural live behavior.
