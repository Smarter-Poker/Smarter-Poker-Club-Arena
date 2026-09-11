# Club Arena Working Context

Club Arena is independently built and published from this repository to the Hetzner Club Arena production services. The World Hub provides the public navigation/routing surface only; it is not a Club Arena build or deployment authority.

Canonical release and verification instructions:

- `.github/DEPLOYMENT.md`
- `.agent/architecture/deploy-paths.md`
- `.github/workflows/publish-club-arena.yml`
- `.github/workflows/auto-deploy-hetzner.yml`

All production changes must travel through a reviewed branch, protected merge, exact-SHA workflow deployment, and live provenance verification. Do not use direct root SSH deployment instructions, direct pushes to `main`, hook bypasses, force inputs, Vercel deployment paths, or World Hub copy/synchronization paths for Club Arena.

Credentials belong in GitHub repository secrets or the designated Hetzner host secret files. Source-controlled documentation and environment examples must contain names and placeholders only, never live values.
