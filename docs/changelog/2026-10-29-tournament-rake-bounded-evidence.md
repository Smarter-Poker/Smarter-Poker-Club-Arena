# Tournament rake evidence retains a bounded physical path

What existed: the weekly tournament quality query reads all17 original fingerprint inputs from rake_records. Actual full-query profiles measured47–87 seconds and about79k physical reads in that heap path. A generic wide covering index cannot safely admit arbitrary JSONB/text values.

What changed: three new migrations install one private exact decompressed-JSONB size helper and two separate concurrent indexes: bounded all17-field cover plus complementary two-UUID keys. Every original row remains eligible for the original calculation; oversized values use the fallback. Existing34 function owners,20 columns,8 constraints,19 indexes,39 trigger rows, ACL/RLS and source65/GEN are guarded without rewriting them. No quality function, fingerprint or financial row changes.

Why: this supplies a safe physical path for the measured heap bottleneck without narrowing financial eligibility, changing a timeout or introducing a payer/cache/repair loop. Individual BIGINT casts prevent predicate arithmetic overflow from blocking a legal fallback.

Verification: focused private PG17 guard/CCI/permissions/JSON identity/partition/natural-plan/recovery checks and source/CI wiring checks are maintained with this change. The fixture transparently adapts OIDs and financial collaborators. Protected CI, install/readback and full live consumer capacity remain separate; this source change alone does not close a book or prove future automation. TypeScript validation is recorded in the PR after execution.

Connected CI blocker: the overload law scanned stored JSON catalog definitions as one SQL stream. Its comment/header regex then joined an old trigger header inside JSON to the following real private helper, inventing a signature change. The scanner now preserves outer literal boundaries and inspects decoded JSON string values separately. It still refuses actual, dynamic and JSON-extracted additional overloads without their original-signature drop; focused positive/refusal regressions use the same offender comparison as the migration scan. Migration bytes and financial guards are unchanged.
