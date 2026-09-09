# tests/stage-one-cutovers-require-entry-freeze.law.test.ts

Every stage-one tournament authority or retirement cutover takes the canonical lock order, requires a live maintenance entry freeze except on an exactly pristine replay, and rechecks that freeze before commit.
