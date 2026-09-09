# tests/diamond-custody-has-no-recovery-rail.law.test.ts

Diamond custody reserve and release stay service-only and atomic: a refused wallet credit rolls every custody rail back, a replay returns the one stored receipt without writing again, and no obligation queue, reconciler, recovery writer or browser-callable internal writer can return.
