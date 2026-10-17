# Weekly bank receipts use their correlation index

The original Oct 5–12 accounting qualification must inspect every ledger leg of each deleted-wallet bank return. Production has no index on `chip_ledger.correlation_id`. The original empty prior-receipt query sorted the 14.18 million-row ledger and spilled over 6 GiB; the bounded array lookup removed that sort but still took 35.883827 seconds in the complete witness. A subsequent qualification exhausted its unchanged 240-second statement limit there. These trials rolled back without paying round two.

Migration `20261017083951` adds one concurrent, nonunique UUID btree index for every non-NULL correlation. No category, club, date, status or player restriction is introduced: all duplicate and unexpected operation legs remain visible. The migration refuses a same-name index with the wrong table, key, predicate, access method, operator class, collation, options, owner or validity flags. It changes no function, trigger, permission, source seal, wallet, receipt or time budget.

The maintained concurrent-preamble installer owns the build, DDL/runway admission, verified TLS, validity readback and exact recorded migration. A lost acknowledgment or invalid build requires catalog/operation recovery before another request. The new index is not evidence that the original week or its alerts are settled.

The existing required accounting qualification invokes a focused native PostgreSQL regression that compares complete correlation receipt sets before and after the exact migration, preserves duplicate legs and NULL semantics, checks the indexed access path and refuses wrong metadata. Production installation and original-week financial completion remain separate required evidence.

Local qualification passed all 15 cases on 20,008 isolated rows, using the exact migration and the receipt reader's bounded UUID-array access shape. Complete rowsets stayed equal; shared blocks fell from 2,865 to 12. The maintained concurrent-preamble unit checks passed 21 cases, Python syntax passed and TypeScript compiled. These fixture measurements do not claim a production build duration or a completed weekly settlement.
