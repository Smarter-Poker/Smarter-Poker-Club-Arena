# tests/law/DiamondJournalNamesBothSidesAndSurvivesDeletion.law.test.ts

Every diamond journal row the two primitives write names its issuance_class and its counterparty; a positive credit with no reference is recorded (DR4, log only) and still paid; a profile deleted with a balance leaves a 'deletion:<id>' burn in ca_mint_ledger and its journal is copied into ca_diamond_journal_archive, which has no foreign keys (Diamond Accounting Standard DR3/DR4/DR5, Lane C)
