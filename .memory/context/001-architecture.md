# Club Arena Architecture

Club Arena owns its player client, real-time poker engine, monitoring, and release workflows.

- Static client origin: `https://ca-static.smarter.poker`
- Real-time engine: `https://engine.smarter.poker`
- Production host: Hetzner Club Arena
- Database and authentication: Supabase
- Public route: `https://smarter.poker/hub/club-arena`

The World Hub may route players to Club Arena, but it must not build, copy, mutate, restart, or publish Club Arena artifacts. Club Arena releases originate in this repository and use the canonical GitHub Actions workflows and repository secrets documented in `.github/DEPLOYMENT.md` and `.agent/architecture/deploy-paths.md`.

Never place login passwords, private keys, tokens, or live credential values in source-controlled Markdown, examples, handoffs, scripts, or environment templates. Store production credentials only in their designated secret stores. Do not disable repository hooks or bypass protected release paths.
