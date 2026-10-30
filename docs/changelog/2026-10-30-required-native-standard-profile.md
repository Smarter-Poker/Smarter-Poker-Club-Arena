# Required native checks retain standard hosted admission

PR #8713 could not start four required engine/PostgreSQL jobs because GitHub refused its paid larger-runner admission. The jobs had no worker or executed steps; this was not a test failure. The same four-shard jobs passed on standard GitHub `ubuntu-latest` in run 40802966649 before the paid profile was introduced.

Only `accounting_postgres` and `server_shards` now default to that existing standard hosted profile. The exact approved repository may opt into the existing `ca-linux-8core` label with `CA_REQUIRED_NATIVE_PROFILE=large`; missing, standard and unknown values retain `ubuntu-latest`. No arbitrary runner label, self-hosted route, automatic retry or publisher is introduced. Other jobs and budgets are unchanged.

All job steps, selectors, four-shard matrices, financial assertions, 50/25-minute ceilings, artifacts and the required Server Engine join remain unchanged. Truth-table coverage executes both actual expressions for the default, explicit large, unknown values and other repository identities. Current required hosted execution is still necessary; historical success is not current-suite qualification or live engine activation.

Connected admission guards retain the exact new profile expression and Linux/Node 22 requirement. The retained BBJ current-job reader accepts only the two approved single-label hosted profiles for the transferred repository; old-repository standard-only admission and all checkout, source, run, attempt, runner, platform, budget and financial checks remain intact. Negative controls continue to refuse wrong, mixed and self-hosted labels.
