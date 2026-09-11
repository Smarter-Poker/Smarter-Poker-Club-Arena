# Current accounting function fixtures

These are read-only `pg_get_functiondef` captures from the installed Club Arena database on 2026-09-11. The separately sealed E2/D10 schema fixtures omit these closure members. The native runners load them only into their own temporary PostgreSQL clusters; the production migration does not load fixture files.

| File                        | Installed `prosrc` MD5             | File SHA256                                                        |
| --------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| `current-exact-refund.sql`  | `0024ca5acfc4e4e12b51a4609349e98d` | `8839436f2ea8dfe7e4a38913dfd7646f030c8f62be6e90671a0ff3aba562e840` |
| `fn_collect_bounty.sql`     | `313a8a2387f7cdcec3d84a961210ceff` | `2bfdf9b2bfdd1abe49ebe072851f6b91a9e8f5c2edda087226740dec539576e9` |
| `fn_mystery_bounty_pay.sql` | `8f16f673aeaafac711da36b0df9466a2` | `e0aac981d7ac7739eccb80b539b82a18d585477d9d304426f4f56c138df337ef` |

The make-good migration pins both changed bounty function bodies. The refund function remains unchanged and is exercised through its real existing entry point. Its already-satisfied repeat refuses with zero newly owed rather than returning a cached success; the test requires the entire resulting financial state to remain unchanged.

All added treasury custody and negative-case mutations are explicitly marked local fixture construction. They are not funding evidence, proposals, or payments for production. The sealed archive's SHA256 and each tested migration's SHA256 are included in the native result receipt.
