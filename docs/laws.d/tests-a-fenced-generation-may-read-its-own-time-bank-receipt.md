# tests/a-fenced-generation-may-read-its-own-time-bank-receipt.law.test.ts

A fenced tournament-manager generation may re-ask fn_consume_time_bank and is answered only from the receipt its request id already committed, never debiting, so a lost debit answer cannot wedge a stopped table or the restart certificate (spin 20a7de08 table 9aa37b13, 2026-10-03).
