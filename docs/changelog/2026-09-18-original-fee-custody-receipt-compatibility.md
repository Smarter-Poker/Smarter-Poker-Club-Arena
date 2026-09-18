# Original fee custody receipt compatibility

Thirteen explicitly identified historical tournaments have original fees whose earning agreements are incomplete. Their existing prize and bounty authorities must finish player outcomes while preserving the full 700.52 chips in the original fee escrow.

The engine now accepts only the exact version-3 custody receipt for these thirteen events: original fee amount, source count and fingerprint, immutable obligation identity, complete player payouts, zero prize and bounty liabilities, retained fee balance and no invented bank receipt. Ordinary version-1 and version-2 completion remains strict. A subsequently proven canonical fee resolution must match the same original source and bank proof.

This engine compatibility change must be deployed before the separately qualified database successor may emit version-3 receipts. It does not itself activate custody or move chips.

Validation: 74 receipt-decoder and 54 direct RPC tests passed; server TypeScript passed. The maintained decoder accepted five actual PostgreSQL custody receipts from the isolated financial qualification. The database owner separately qualifies the original eight-event prize/bounty and separate five-Spin, replay, concurrency and original-fee continuation paths before installation.
