# The Club Arena static origin

`smarter.poker/hub/club-arena` is served from here. Since 2026-09-03 the
bundle is not copied into the World Hub repo and is not a Vercel deployment:
`publish-club-arena.yml` rsyncs `dist/` to this box and the World Hub carries
one rewrite to it (`next.config.js`, `afterFiles`).

|              |                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Host         | `ca-static.smarter.poker` -> `estate-ci-1` (Hetzner cpx41, Ashburn)                                                              |
| Server       | Caddy 2.11, config = `Caddyfile` beside this file                                                                                |
| Root         | `/srv/club-arena`                                                                                                                |
| Published by | `.github/workflows/publish-club-arena.yml`, job `publish-to-origin`                                                              |
| Credentials  | repo secrets `CA_ORIGIN_SSH_KEY` / `CA_ORIGIN_HOST` / `CA_ORIGIN_HOST_KEY`; the publisher connects as the unprivileged `ci` user |
| TLS          | Let's Encrypt, automatic. The domain's CAA allows `letsencrypt.org`                                                              |

## Layout

```
/srv/club-arena/releases/<ca_sha>/   one directory per published bundle, 10 kept
/srv/club-arena/current -> releases/<ca_sha>   swapped atomically after the rsync
/srv/club-arena/pool/{assets,fonts}/           ADDITIVE, pruned by age (30 days)
```

**The pool is not an optimisation.** A player whose tab still holds the
previous `index.html` asks for the previous hashed chunks mid-hand. The
publisher never passes `--delete` to the pool syncs and prunes it by mtime
only. Pruning it by "not in the current bundle" is the 404 the World Hub
sync's retention logic existed to prevent.

## Rollback

```bash
ssh -i ~/.ssh/hetzner_deploy root@$(security find-generic-password -a smarter-poker -s estate-ci-ip -w) \
  'cd /srv/club-arena && ls -1t releases | head && ln -sfn /srv/club-arena/releases/<older sha> current.tmp && mv -Tf current.tmp current'
```

Then confirm through the public URL, which is what a player uses:
`curl -s https://smarter.poker/hub/club-arena/build-info.json`.

## The single point of failure, and what covers it

While the bundle lived in the World Hub's `public/` tree it was served by
Vercel's CDN and could not fail on its own. Now this one box is in the path of
every Club Arena page load. Two things soften that, and one does not exist yet:

- **Hashed assets and fonts** are `immutable`, so Vercel's edge keeps serving
  them for a year without asking this box anything.
- **The shell** (`index.html` and every SPA route) is
  `s-maxage=60, stale-while-revalidate=86400, stale-if-error=86400`: the edge
  revalidates once a minute and, if this origin is unreachable or erroring,
  keeps serving the last good shell for a day. A reboot here is invisible; a
  publish is delayed by at most a minute.
- **Not yet: a second origin.** The honest gap. `releases/` and `pool/` could
  be rsynced to `estate-ci-2` and the DNS A record pointed at whichever
  answers - the boxes and the key already exist. Until that is built, a box
  lost for more than a day takes Club Arena's shell with it.

## Changing the config

Edit `Caddyfile` here, then `bash infra/ca-origin/deploy-origin-config.sh`
(`DRY_RUN=1` to see the diff first). It validates on the box before reloading
and verifies through the public hostname afterwards. Do not hand-edit
`/etc/caddy/Caddyfile`: this file is the truth, and a box rebuild replays it.
