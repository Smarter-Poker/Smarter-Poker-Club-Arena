# server/src/engine/StaleContinuationSweep.law.test.ts

Settlement reads its own hand rather than the live fields, so a later hand cannot rewrite an earlier settlement
