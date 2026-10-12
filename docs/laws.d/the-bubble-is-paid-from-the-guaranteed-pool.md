# tests/the-bubble-is-paid-from-the-guaranteed-pool.law.test.ts

The guarantee check counts the bubble protection refund and any overlay backpay as money the guarantee paid out, so an event that paid its whole guaranteed pool is never read as short.
