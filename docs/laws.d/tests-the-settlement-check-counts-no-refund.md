# tests/the-settlement-check-counts-no-refund.law.test.ts

The tournament settlement check counts only places as paid: a registration refund is never read as a prize, so an event that refunded an entry is neither reported overpaid nor able to hide an underpayment, exactly as the prize overpay reader already reads it.
