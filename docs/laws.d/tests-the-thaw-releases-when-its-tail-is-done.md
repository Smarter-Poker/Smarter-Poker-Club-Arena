# tests/the-thaw-releases-when-its-tail-is-done.law.test.ts

The v3 maintenance thaw's release runway is 4 seconds per installment its tail actually needs. That is the slowest step's ceil(count / batch), using the credit worker's own 40/200 batch sizes. It is never one 40-row call per target, and a missed estimate still rebases with a doubled runway. Otherwise a finished thaw holds the whole platform closed for about three minutes after every :00.
