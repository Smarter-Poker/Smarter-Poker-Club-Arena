# Retained originals use their existing per-table lane

The 22:45 UTC incident showed a retained original save waiting for the exclusive tournament terminal lane while sibling post-commit projections held the shared lane across statistics-row waits. The retained-save RPC only changes one table's private continuation. Its exclusive prefix unnecessarily coupled the original's durability to other tables.

The new migration substitutes the already installed `fn_ca_f06_share_table_lane` for that one prefix. It preserves the lease fence and recheck, global shared authority, exact table and ordered seat locks, and every original/sequence/disposition/freeze/financial guard byte for byte. Terminal and tournament-wide writers retain their exclusive authority. Both function preimages, owners, ACLs and configuration are checked, and reverse substitution proves no other function change.

Qualification lives in the existing required continuation PostgreSQL lane: actual sibling projection shared-lane hold fails the old retained-save RPC and permits the same original after the substitution; same-table, lease and terminal exclusion remain required, alongside all 37 original/financial boundaries and complete rollback. The unknown statistics-row holder and separate lease delays are not claimed fixed by this change.

Validation: the complete existing native continuation runner passed, including the new before/after lane regression, four installation-drift refusals, all 37 original/financial boundaries on the candidate, and clean cluster removal. Root TypeScript compilation, 21 connected source contracts and 1,764 unchanged source-binding pins passed.

State: committed source preparation only. Normal integrated push, hosted checks, installation and live continuity remain separate evidence. No production mutation or release is performed by this test.
