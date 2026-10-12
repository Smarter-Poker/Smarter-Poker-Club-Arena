# V4 policy identity in TypeScript consumers

The loader strips only SQL NULL policy metadata at the database transport boundary. Public row and evaluation inputs reject explicit null, undefined and unknown schemas. The exact V4 literal is carried through dataset consistency checks, dataset metadata, decision source seals and immutable evaluation configuration.

Legacy omitted-schema seal and evaluation bytes remain unchanged. Focused tests cover legacy, exact V4, mixed-dataset refusal and malformed metadata. The evaluator uses a pure tested configuration builder without importing its operational entrypoint in tests.

This is source-only contract wiring. It does not qualify a numeric-state predictive model, change quality thresholds, activate a dataset, execute solvers or publish a release. Matching SQL consumer contract is migration 20261007051641.
