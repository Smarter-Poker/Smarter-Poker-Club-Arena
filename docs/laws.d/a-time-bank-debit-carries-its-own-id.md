# tests/a-time-bank-debit-carries-its-own-id.law.test.ts

Pins migration 20260928152513: `fn_consume_time_bank_once` takes the per-user time bank lock, reads the debit id's receipt, performs the unchanged `fn_consume_time_bank`, and records the receipt in the same transaction, so asking again by id is exactly-once; it is engine-only, its receipts are append-only, and the original debit function is guarded on its production pre-image and never redefined here.
