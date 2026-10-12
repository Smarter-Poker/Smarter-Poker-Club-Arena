# tests/cashier-totals-read-the-range-as-concurrent-slices.law.test.ts

The default owner cashier total reads each source range as consecutive slices that partition the range exactly, so a cold total reads several index chains at once instead of one, and every other statement path stays byte-identical.
