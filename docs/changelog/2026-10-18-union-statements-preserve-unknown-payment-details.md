# Historical Statement Payment Details Stay Unknown

The live Midway Statements page returned RPC200 but failed its accounting decoder: the October5 JAQK and SHARK invoices are marked paid without a `paid_total` field. Treating that absence as zero produced a contradictory paid invoice with an outstanding balance. No external payment amount can be inferred from that status.

The board now identifies those legacy rows explicitly. Invoice economics and recorded status remain unchanged; payment and remaining-balance fields, and aggregates depending on them, are unavailable. The Statements page, CSV and union overview preserve that distinction. Existing complete payment details still reconcile exactly; inconsistent modern rows remain refused. Unknown legacy records cannot be reopened by the page. No invoices, wallet movements or money rules are changed.

Migration20261018170308 was reserved through the maintained helper. Native PostgreSQL17 reproduces the old contradiction and checks the corrected unknown fields, valid partial payments, original caller gate, immutable source rows and replay refusal. Qualification runs in the existing required Data Console union-reporting job. Component and decoder tests cover visible uncertainty and prevent zero or a numeric aggregate being substituted for unknown details.
