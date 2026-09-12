# Compare insurance quotes with the durable bank and ledger

The independent financial checkpoint observer now compares one actual full-coverage quote and acceptance response with the completed hand's winner list, insurance receipt, signed club insurance bank, and immutable ledger counterpart. It distinguishes the club named by the receipt from the wallet named by the ledger. A sole winner pays the quoted premium, a loser receives the insured amount without a fee, and a chopped winner is a zero-charge push.

The comparator checks numeric cents without floating-point accounting and rejects changed history, duplicate or missing receipts, contradictory winners, changed bank identities, and mismatched amounts or endpoints. The acceptance check follows the actual response: status, premium, and insured amount; that response does not contain a coverage percentage.

Validation: 96 local Node tests passed across the actor, route phase, top-up verifier, insurance verifier, and checkpoint coordinator. These include 33 insurance comparison cases with fabricated adversarial inputs. They are observer checks, not a genuine funded Auth/engine journey or production certificate. The outer real fixture wiring, felt-to-database reconciliation, complete source/schema qualification, and canonical cleanup proof remain open.
