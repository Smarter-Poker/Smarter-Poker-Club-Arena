# Bind the existing proof to the normalized migration header

Protected #8526 (`915d5e2ac0ae3a9c8d10eb3de38cfb1d56cf733d`) normalized only the `@live-proof` annotation in `20261029011340_legacy_postflop_void_preserves_original_principal.sql`. The prior bytes hash to `53431ffdabd682f27dc4718775eaa149ae13fc91e2c43910b789cd40782411a7`; the current bytes hash to `af928c3de7304cdc42518e3337efc127c6125004d8877caedca906c01160a6aa`. Reversing that exact one-line normalization reconstructs the entire prior file byte for byte. Financial SQL and its required postimage are unchanged.

The later protected registry composition retained the old file hash and old `SELECT ... AS installed;` replacement, so the strict default-main migration-ledger reader refuses every invocation before querying. Update only that active registry entry to the exact current file and current inline marker. Preserve the same single `e416f1fa850c85d656ec55ddfae3386d` predicate. The reader and all its strictness remain unchanged. No migration, SQL body, qualification receipt or production data changes; no installation or execution claim.

Regression exercises the actual current registry and migration through `resolveDeclaredProofs`, requires exactly one unchanged predicate, and retains rejection of both the old hash and a replacement marker absent from the current file.

The exact prior entry is retained here as historical audit evidence:

```json
{
  "file": "20261029011340_legacy_postflop_void_preserves_original_principal.sql",
  "sha256": "53431ffdabd682f27dc4718775eaa149ae13fc91e2c43910b789cd40782411a7",
  "replaces": [
    "SELECT md5(pg_get_functiondef('public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)'::regprocedure)) = 'e416f1fa850c85d656ec55ddfae3386d' AS installed;"
  ],
  "proofs": [
    "md5(pg_get_functiondef('public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)'::regprocedure)) = 'e416f1fa850c85d656ec55ddfae3386d'"
  ]
}
```
