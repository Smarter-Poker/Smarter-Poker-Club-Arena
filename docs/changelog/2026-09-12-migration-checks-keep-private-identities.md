# Migration Checks Keep Private Identities

The migration checker previously read a qualified private table name as a public table named smarter_private. It now preserves complete PostgreSQL identifiers, uses distinct table/column tuple identities and ignores declaration keywords inside quoted identifiers. This catches missing objects without confusing quoted names, Unicode case or real drops.

Schema generation requires complete private catalog coverage and validates every metadata response before writing snapshots. The service-only helper was verified through the real endpoint; captured responses and an independent catalog matched seven private tables, sixteen routines and fifty-one columns. Required public-column behavior stays unchanged.

Independent review accepted the final parser/generator source after adversarial CLI checks. Root repository tests separately passed forty-three parser/catalog cases and seventeen actual CLI cases after adapting the test path for the repository browser test environment. These are source and metadata checks; they do not certify financial journeys or deployment.
