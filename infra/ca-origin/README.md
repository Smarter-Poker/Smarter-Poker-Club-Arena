# Club Arena Static Origin

`https://smarter.poker/hub/club-arena` is routed to the Club Arena-owned static origin at `https://ca-static.smarter.poker`. The built bundle is never copied into World Hub and is never published through Vercel.

| Contract         | Value                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| Production host  | Hetzner Club Arena origin                                                                               |
| Release root     | `/srv/club-arena/releases/<ca_sha>/`                                                                    |
| Active release   | `/srv/club-arena/current`                                                                               |
| Asset pool       | `/srv/club-arena/pool/{assets,fonts}/`                                                                  |
| Publisher        | `.github/workflows/publish-club-arena.yml`                                                              |
| Runtime identity | Unprivileged `ci` user with pinned host key                                                             |
| Credential store | Club Arena GitHub Actions secrets named `CA_ORIGIN_SSH_KEY`, `CA_ORIGIN_HOST`, and `CA_ORIGIN_HOST_KEY` |

The publisher uploads a complete immutable release, verifies its provenance, atomically swaps `current`, and retains prior hashed assets so tabs already open at a poker table do not lose chunks mid-hand. The World Hub only routes the public path to this origin.

Every change travels through a reviewed Club Arena branch and protected `main`. A normal merge invokes the publisher. A manual recovery uses the default-branch-only repository event `publish-club-arena`; never use branch-authored workflow dispatch, workstation SSH, direct symlink changes, World Hub copies, or Vercel.

If a release must be reversed, revert the defective change through a reviewed commit on `main` and publish that new forward commit. Production provenance is verified at both endpoints:

- `https://ca-static.smarter.poker/build-info.json`
- `https://smarter.poker/hub/club-arena/build-info.json`

`Caddyfile` in this directory is the disaster-recovery declaration for a newly provisioned origin. It is not a workstation deployment mechanism. Infrastructure configuration changes require their own reviewed, fail-closed Club Arena automation before they may alter the host.
