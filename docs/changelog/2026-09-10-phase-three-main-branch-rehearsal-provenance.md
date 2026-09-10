# Main-Branch Rehearsal Provenance

The Phase 3 cash-payer rehearsal previously fetched settlement-lane SQL from a historical sibling-branch commit. A fresh clone of main could lack that object after branch cleanup. The runner now reads the byte-identical migration tracked on main and requires SHA-256 `d07cbe35f62ef4a18e29779c812526c27420da4a82c891c0bf2f136b9e6a31fe`. It retains the original temporary filename because that name is part of the composed SQL provenance.

Source-only validation ran from 2026-09-10T15:19:58.081951Z to 15:19:58.157209Z. Old and corrected loaders produced byte-identical complete SQL for every existing variant. Database entrypoints were not called, and subprocess entrypoints were denied during composition. A mutated source was refused before output. Python syntax and git diff checks passed. This is reproducibility validation, not a new database acceptance run.

| Variant |  Bytes | Old And New SHA-256                                              |
| ------- | -----: | ---------------------------------------------------------------- |
| Paid    | 238850 | 4ab0cc9fe1243d0d08cb7c5ff1553b05f1755287f08f85a02961e36a12fdfb00 |
| Unpaid  | 237854 | 8e90f3e2c8a5eac3b3498f9bfb509862f644c73eed2259d8293009fe7c4a1fce |
| Partial | 238849 | ea2f3e5c409ba03b9780e4df85c5e5623e37a39259b64ca58898027d3e696bad |

The accompanying [release and orphan audit](../audits/2026-09-10-phase-three-release-and-orphan-audit.md) accounts for thirteen historical task branches, all final prepared/proof files and outstanding acceptance. This change does not apply prepared SQL or activate financial authority.
