# Release Evidence

The engine image is built from `server/` alone (`server/scripts/build-engine-image.sh`), so nothing under the repository's `docs/` reaches production. A Horse Brain protected release selection is admitted on the engine only from files it can read, so every file a committed selection reads is committed here too, at the same repository-relative path, byte for byte:

- the qualification file the selection names (`docs/evidence/phaseN/phaseN-qualification-*.json`);
- the strength record that qualification names (`docs/evidence/phaseN/strength-*/strength.json`);
- the natural completion record, when the phase requires one (`docs/evidence/phaseN/phaseN-completion-*.json`).

`server/Dockerfile` copies this directory to `/app/release-evidence/`, and `repositoryEvidenceReader` (`server/src/engine/HorseQualifiedAuthority.ts`) reads it first. `server/src/engine/aSelectedPackShipsItsEvidence.law.test.ts` admits every committed selection from this directory alone and refuses any file here that differs from its `docs/` original.
