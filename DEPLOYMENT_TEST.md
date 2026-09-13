# Club Arena - Automatic Deployment Test

This file was created to test the automatic GitHub Actions deployment pipeline.

**Historical test:** 2026-01-29 13:53 CST

Current credential readiness must be verified from repository secret names and
an exact successful release run; this document does not assert secret values.

The deployment pipeline automatically:

1. Builds and tests the exact protected Club Arena `main` SHA.
2. Publishes the immutable frontend release to the Club Arena Hetzner origin.
3. Verifies the origin and public rewrite serve that exact SHA.

The World Hub only routes `/hub/club-arena/*`; it does not build, copy, cache,
or publish Club Arena. Vercel is not part of the Club Arena release path.
