# Engine deploy path is not landing — diagnosis + Antigravity prompt

Recorded 2026-08-16 ~16:00 UTC by the Cowork agent (no SSH, no GitHub write).

## Evidence

1. **No engine restart in 14.8 hours.** Largest gap between consecutive rows in
   `hand_history` since the 01:09:11 recovery is **15.7 seconds**. `engine-up.sh`
   does `docker stop -t 45` then a rebuild and boot; that cannot complete in 15.7s.
   So the container has not been replaced once today.

2. **A `server/**` change merged an hour before that measurement.** `b38ad8db`
   (rake RPC rename) touches `server/src/services/supabase/rake.ts`, which matches
   the `auto-deploy-hetzner` path filter. It should have cut over. It did not.

3. **The engine host moved during the incident response.**

   ```
   engine.smarter.poker  01:30 UTC → 178.156.160.206
   engine.smarter.poker  16:00 UTC → 5.161.252.33
   ```

   Both still answer on :443. `178.156.160.206` is the host the fleet audit says
   is *not in the Hetzner project* and went out of DNS at 01:30:50Z.

## Two hypotheses, both cheap to check

**A — `HETZNER_HOST` is stale.** The workflow SSHes to `secrets.HETZNER_HOST`
but health-checks `ENGINE_URL=https://engine.smarter.poker`. If the secret still
holds `178.156.160.206`, the pipeline deploys to the old box and verifies against
the new one. The version gate can then never match, verify fails, and it rolls
back — every single run. This also retro-explains PR #72's failure last night,
which was attributed solely to a stale container.

**B — the new firewall blocks the runner.** Remediation created firewalls where
the project had none, restricting :22. GitHub Actions runners use ephemeral IPs.
If those ranges are not allowlisted, every deploy dies at "Setup SSH key" /
"Capture pre-deploy state".

A and B compound: fixing one still leaves the other.

## Do NOT hand-roll the container start

`server/scripts/engine-up.sh` is the single source of truth for the run-spec.
The header of `update-hetzner-env.yml` documents six independent outages caused
by an ad-hoc `docker run` — wrong port (3001 vs 8080), `:latest` tag, missing
`--label autoheal=true` (which silently disables self-healing), `--restart
unless-stopped` instead of `always`, no log caps, and a 10s stop grace that
SIGKILLs the engine mid hand-state flush. Always go through the script.

## Verification signal once PR #74 is deployed

Enforcement ships off (`ENGINE_LEASE_ENFORCE` unset), but `claimTable()` and
`heartbeatTables()` still run, so the table fills on its own:

```sql
select instance_id, engine_version, count(*), max(heartbeat_at)
from engine_table_leases group by 1,2;
```

- one `instance_id`, ~one row per active table  → deployed, healthy, single owner
- **two or more `instance_id` values**          → split-brain, caught automatically
- zero rows                                      → the new build is not running
