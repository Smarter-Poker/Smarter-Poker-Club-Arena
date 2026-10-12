# tests/the-ledger-replay-sees-what-a-subtransaction-wrote.law.test.ts

Every journal leg records the top-level transaction that commits it and the ledger replay judges a leg by that, never by a subtransaction's xmin; a union rake payment names the rake wallet on its union side, so the replay can key it.
