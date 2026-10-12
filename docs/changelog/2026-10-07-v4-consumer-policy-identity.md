# V4 policy identity at the consumer boundary

Migration 20261007051641 appends nullable `policy_export_schema` to the two
service-only active/evaluation cell RPCs and binds it to approved bundle,
dataset, and cell metadata. It rejects mismatched, explicit-null and unknown
evaluation/decision-seal identities without changing any quality thresholds.
Legacy omitted metadata remains omitted in JSON consumers; SQL transport NULL
must be stripped only at the RPC adapter boundary.

The existing V4 source migration already includes the policy schema in cell
identity and seal/promotion dataset digests. This migration finishes its SQL
evaluation configuration and actual-decision source-seal bindings. Five exact
function preimages, unchanged ownership/security/ACLs and exact postimages are
checked. The documented function-only rollback is executed and recovered in
the maintained isolated PostgreSQL17 fixture; it never replays historical DDL.

## Required TypeScript follow-up

Use the modern feature-contract consumer, not the older helper checkout:

- `server/src/engine/GtoPostflopV31.ts`: optional literal
  `policy_export_schema: 'smarter-poker.pio-policy.v4'` on source seals, strict
  admission, dataset identity and returned decision seals.
- The V31 loader's RPC adapter: strip SQL NULL for legacy omission; never
  normalize explicit unknown/NULL values in directly supplied JSON.
- `server/src/scripts/gtoV31Evaluate.ts` and its configuration builder: carry
  the same optional field into candidate configuration and every immutable
  evaluation/source identity.

## Explicit qualification boundary

Complete numeric public state and exact node ranges are validated _source_
inputs. Current compact cells still aggregate thirteen coarse context fields
and versioned hand features. Metadata transport does not transform those
cells into a complete-numeric-state predictor. No V4 model, new dataset,
promotion, solver execution, production installation or live activation is
claimed by this source-only change. A genuine complete-state model requires
its own immutable prediction contract and unchanged held-out quality proof.
