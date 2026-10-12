# tests/the-felt-counts-an-insured-hand.law.test.ts

The felt counts an insured hand: between the two halves of a cash hand the ledger replay's felt reader counts the hand as rake + bbj - inflow read from its stack result, the same quantity the per-transaction ledger invariant carries, so an insured hand's inflow is never read as drift and the two definitions of the felt cannot disagree.
