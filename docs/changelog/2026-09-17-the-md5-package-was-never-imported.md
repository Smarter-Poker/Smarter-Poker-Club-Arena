# The md5 package was never imported, and the engine edge has nothing to compress

`md5` and `@types/md5` are gone from `dependencies`. Neither was imported
anywhere: every `md5` token in this repository is PostgreSQL's own `md5()`
inside a SQL string in a contract test, not the npm package. Removing the two
declarations also drops `charenc`, `crypt` and `is-buffer`, which were present
only to satisfy `md5` — a forty-three line deletion in the lockfile with no
version changes and nothing added. Nothing imported them, so no bundle shrinks;
what shrinks is what `npm ci` installs and what a reader has to account for.

The performance audit had also recorded an operator step for engine-01: add
`encode zstd gzip` to the live `/etc/caddy/Caddyfile` and reload. That step is
withdrawn, because the bytes it was meant to save are already compressed and
the ones it would reach are not player traffic. Measured against production on
2026-09-17: every Club Arena bundle on the path a player actually loads answers
with `content-encoding: zstd` and `cache-control: public, max-age=31536000,
immutable` — `index` at 158,905 bytes, `vendor-react` at 76,501, the stylesheet
at 40,570 — and the static origin answers zstd for its shell. The World Hub
answers `br`. The only origin without a `content-encoding` is
`engine.smarter.poker`, and on the live box that hostname serves the engine
reverse-proxy alone: `/grafana/login` and `/runbooks/00-incident-response.md`,
both routed by the repository template, return the engine's own 21-byte JSON
404, so the template's Grafana, Prometheus, AlertManager and runbook handlers
are not what is loaded there. What remains behind that name is WebSocket
traffic, which `encode` never touches, and JSON: `/health` is 9,583 bytes and
gzips to 3,555. That is a real 63 percent, on a monitoring endpoint, worth no
exclusive-lock risk on the box that deals cards, and worth none of an operator's
evening. The line stays in the repository templates, which describe a
configuration that would benefit from it; no one needs to go and apply it.

The gap between those templates and the live file is worth a separate look by
whoever owns the box. This change does not touch engine-01, the Caddy
configuration, or any runtime code.
