# HANDOFF PROMPT: Commission the certified V31 PioSOLVER pipeline (Horse Brain, smarter.poker)

Paste this whole document as the first message of a fresh chat. Facts below were verified 2026-10-05 between 23:20 and 23:45 UTC unless a line says otherwise. Every claim is paired with the command that re-checks it. Re-run those checks before you act: this estate has many agents writing to it in parallel.

---

## PART 0. Who you are and what you are picking up

You are the agent responsible for ONE workstream: getting the certified V31 PioSOLVER pipeline from "built but never commissioned" to "a promoted, certified dataset the live horse brain loads". Horses are the AI players of smarter.poker Club Arena. Never call them bots.

The owner is Dan (daniel@bekavactrading.com). His standing instruction, in his words: "nothing is ever for me to do, this is ALWAYS YOURS" and "FULLY BUILD, FIX AND ENHANCE ... MAKE SURE THEY ARE FULLY WIRED IN AND TESTED BEFORE CLAIMING SUCCESS." He does not push, merge, deploy or publish anything himself. You own delivery through to verified-live.

Where you are landing:
- All the software is BUILT and on main: the Windows worker, the signed World Hub gateway, the compactor, the bundle preparer, the PostgreSQL certification functions, the Club Arena loader and the offline evaluator.
- NOTHING has ever run through it. Every V31 table is empty (Part 4).
- The two PioSOLVER Windows hosts, M1 and M2, EXIST (Dan, 2026-10-05: "THOSE MACHINES DO EXIST, AND THE DATA IS ALREADY STORED IN THE SUPABASE FOR SOLVED HANDS VIA THE PIOSOLVER"). They ran the LEGACY harvest into `solved_spots_gold` (8.87M solved spots, 80 GB) until 2026-09-10 (M1) and 2026-08-16 (M2).

What went wrong before you, stated plainly:
1. The previous agent (Claude, 2026-10-05) told Dan the machines and licensed binaries "do not exist". That was wrong. It was copied from a 2026-09-27 migration comment instead of checking `solver_status` and `solved_spots_gold`. Do not repeat the mistake: verify the estate yourself before you assert anything about it.
2. That same agent then proved the existing warehouse CANNOT be converted into V31 artifacts (Part 5.1). That conclusion holds; do not spend time re-trying it.
3. Neither M1 nor M2 was reachable from the Mac Studio or from the cloud session (Part 5.2). That is the real blocker.

---

## PART 1. STOP CONDITIONS. Read before any work.

### 1.1 Binding rules from Dan and the estate policy

> "nothing is ever for me to do, this is ALWAYS YOURS"

> "MAKE SURE THEY ARE FULLY WIRED IN AND TESTED BEFORE CLAIMING SUCCESS."

> "no watcher shall stand in place of a fix" (his standard: fix defects at the source, never add a cron, watcher, reconciler or repair loop instead)

He treats pushed, tested, merged, installed, published and verified-live as SEPARATE states. Report each one separately.

### 1.2 Hard prohibitions

- Supabase project `kuklfnapbkmacvwxktbh` ONLY. NEVER `ydsaqnnuwyvtyxgvrnys`.
- NEVER fabricate provenance. Do not synthesize `action_evs_bb`, `matchups`, a combo order, a binary checksum or a manifest checksum. Do not convert `solved_spots_gold` rows into `smarter-poker.pio-policy.v3` nodes by computing or guessing missing fields. The validator will reject most such attempts; the ones it accepted would be worse, because they would be certified lies.
- NEVER install a Supabase service-role key on M1, M2 or the compactor host. The design forbids it, and a law test in Club Arena (`tests/the-legacy-solver-worker-cannot-write-production.law.test.ts`) exists to stop the retired direct-database workers from coming back. Do not revive `scripts/piosolver_batch.py`, `scripts/seed_gto_scenarios.py` or `scripts/windows_piosolver/*`. Those are tombstones.
- NEVER print, paste, log, commit or echo an HMAC secret, a service key or any credential. Do not read `.env` values. Do not decrypt Vercel sensitive variables.
- NEVER call `ca_gto_v31_approve_input_bundle` with anything other than the unchanged approval JSON written by `prepare_bundle.py`. It requires an authenticated horse-admin USER session (it checks `auth.role() = 'authenticated'`, `auth.uid()` and `fn_is_horse_admin()`). It cannot be run with the service role, and you must not impersonate a user or mint a JWT to get around that.
- NEVER promote a dataset (`--promote`) until the candidate's paired-replay and league receipts are green AND you have shown Dan the receipts. Promotion changes live horse behavior.
- NEVER merge a PR with `--admin`, bypass hooks (`--no-verify`) or force-push main.
- NEVER spend real chips or call money-moving functions to test anything (Club Arena CLAUDE.md section 11.5).
- Strategy claims need evidence: never call a result an improvement unless |bb100| > 2 x stderr.

### 1.3 Current gates (what is closed, and what opens it)

| Gate | State (verified 2026-10-05 23:41 UTC) | Opens when |
|---|---|---|
| Approved input bundle | 0 rows in `gto_v31_input_bundles` | A horse admin submits the preparer's approval JSON through an authenticated session |
| Dataset registration | 0 rows in `gto_v31_datasets` | Compactor registers with the approved manifest checksum |
| Source artifacts | 0 rows in `gto_v31_source_artifacts` | M1 and M2 workers upload v3 nodes through the gateway |
| Runtime cells | 0 rows in `gto_v31_runtime_cells` | Compactor builds and seals; evaluator marks candidate; `--promote` |
| Live brain | Loads only `fn_gto_v31_active_cells` (certified, promoted) | A promoted dataset exists |

---

## PART 2. Environment bootstrap. Run these first.

### 2.1 Repos and machines

| Thing | Where |
|---|---|
| Club Arena (engine, DB migrations, loader, evaluator) | GitHub `Smarter-Poker/Smarter-Poker-Club-Arena`; Mac Studio checkout `~/Documents/club-arena` |
| World Hub (gateway + producer scripts) | GitHub `Smarter-Poker/Smarter-Poker-World-Hub`; Mac Studio checkout `~/Documents/Smarter-Poker-World-Hub` |
| Database | Supabase project `kuklfnapbkmacvwxktbh` |
| World Hub hosting | Vercel team `smarter-poker`, project `hub-vanguard` |
| Engine host | Hetzner `5.161.252.33`, container `club-arena-engine` (key path on the Mac: `~/.ssh/hetzner_deploy_ed25519_new`) |
| Solver hosts | M1 and M2: licensed-PioSOLVER Windows machines. Location and access method UNKNOWN (Part 5.2) |

Mac Studio rules (from the repo's `AGENT-PLAYBOOK.md` and `docs/agent-policy/*`; read them in full at start):
- `gh` lives in `/opt/homebrew/bin`; `/bin/sh` does not have it on PATH. Prefix with `export PATH=/opt/homebrew/bin:$PATH`.
- Do ALL local work on the external SSD under `/Volumes/SmarterWork/agent-work/<task>`, never on the internal drive. Create worktrees with `scripts/agent-workspace.sh <agent> <branch-slug> --print-path`. Remove your worktree when the PR is merged.
- macOS `sed` is BSD sed. Use Python for file edits.
- Long commands: a remote tool call that runs more than ~60 s gets cut off. Run long jobs as a detached script (`nohup ./job.sh >/dev/null 2>&1 </dev/null & disown`) that writes its own log and an exit-code line, then poll the log. There is no `setsid` or `timeout` on macOS.
- Pre-push hooks run real test suites and need dependencies installed in YOUR worktree (`npm ci` at the root AND in `server/`). Without root `node_modules` the hook prints `BLOCKED: required local client dependencies are incomplete.`

### 2.2 Prove you are in the right place

```bash
export PATH=/opt/homebrew/bin:$PATH
gh auth status                                   # must show account Smarter-Poker
cd ~/Documents/club-arena && git fetch -q origin && git log -1 --oneline origin/main
cd ~/Documents/Smarter-Poker-World-Hub && git fetch -q origin && git log -1 --oneline origin/main
```

```sql
-- Supabase project kuklfnapbkmacvwxktbh
select (select count(*) from gto_v31_input_bundles) bundles,
       (select count(*) from gto_v31_datasets) datasets,
       (select count(*) from gto_v31_source_artifacts) artifacts,
       (select count(*) from gto_v31_runtime_cells) runtime_cells,
       (select count(*) from solver_worker_heartbeats) worker_hb,
       (select count(*) from solver_compact_heartbeats) compact_hb,
       (select count(*) from solver_ingress_nonces) nonces;
-- 2026-10-05 23:41 UTC: all seven were 0. If any is non-zero, someone else has
-- started. Find out who and what before you touch anything.
```

### 2.3 Credentials: where they are, never what they are

| Credential | Location | You may |
|---|---|---|
| `HORSE_SOLVER_V31_M1_HMAC_SECRET`, `..._M2_...`, `..._COMPACTOR_...` | Vercel `hub-vanguard`, production AND preview, type `sensitive`, set 2026-09-29 | Read the NAMES only. Values cannot be read back. |
| The same three values on the hosts | Must exist as `HORSE_SOLVER_V31_HMAC_SECRET` on each principal's host | UNVERIFIED whether they were ever installed (Part 5.3) |
| Legacy `SOLVER_WORKER_M1/M2_HMAC_SECRET` | Vercel `hub-vanguard` | Legacy path. Do not reuse for V31. |
| Supabase service role | Club Arena engine env and World Hub server env only | Never copy it anywhere, never onto a solver host |

If the host-side copies of the HMAC secrets are lost, the fix is ROTATION: generate three new 32-byte secrets, install each one directly into its destination (the Vercel variable plus the one host that owns it) without printing it, and redeploy the gateway. Never reuse one principal's key for another.

---

## PART 3. How the pipeline works (trigger to live horse)

```
[approved immutable inputs]                       World Hub repo: scripts/horse-solver-v31/
  range-bundle JSON (1,326-combo OOP/IP ranges)
  combo-order.txt  <- captured from the LICENSED binary's `show_hand_order`
  ICM model bundle (null for cash / chip-EV scenarios)
  scenario manifest (targets, each owned by M1 = train or M2 = holdout)
        |
        v  prepare_bundle.py  (clean checkout whose commit is on origin/main)
  manifests/v31-manifest.json  +  approvals/v31-input-approval.json  ("approved": false)
        |
        v  horse admin, authenticated session -> ca_gto_v31_approve_input_bundle(p_bundle)
  gto_v31_input_bundles (approval_status approved)
        |
        v  compactor.py  (compactor HMAC key)  -> gateway -> fn_gto_v31_register_dataset
  gto_v31_datasets (state registered; exit code 2 = waiting for workers)
        |
        v  worker.py M1 / worker.py M2 on each Windows host (own HMAC key, PIO_EXE,
        |    APPROVED_PIO_BINARY_CHECKSUM, APPROVED_MANIFEST_CHECKSUM, PIPELINE_COMMIT,
        |    HORSE_SOLVER_V31_GATEWAY_URL)
        |    Pio UPI: show_version, show_hand_order, build tree, set_accuracy, go,
        |    wait_for_solver, show_strategy, calc_ev PLAYER node, calc_ev PLAYER node:action
        v  POST https://smarter.poker/api/internal/horse-solver-v31  (HMAC-signed, nonce)
  fn_gto_v31_ingest_source_artifact -> fn_gto_v31_source_node_valid (schema pio-policy.v3)
  gto_v31_source_artifacts, gto_v31_cell_source_receipts
        |
        v  compactor.py again: fn_gto_v31_build_cell, fn_gto_v31_seal_build
  (M1 = training evidence, M2 = held-out evidence, disjoint board-rank signatures)
        |
        v  Club Arena: cd server && npm run horse:gto-v31-evaluate -- --dataset=<uuid>
  8 paired-replay / league receipts, gto_v31_release_evaluations, state candidate
        |
        v  same command with --promote (database rechecks every gate): fn_gto_v31_promote_dataset
  gto_v31_runtime_cells (active)
        |
        v  Club Arena engine: server/src/services/GtoPostflopV31Loader.ts
     -> rpc fn_gto_v31_active_cells -> in-memory certified store -> HorseLogic V31 path
```

What is live TODAY instead (do not break it): the legacy warehouse already drives the horses through `gto_postflop_compact` (7,747 cells on 2026-10-05 23:41 UTC), loaded by `server/src/services/GtoPostflopLoader.ts` every 6 hours. The aggregation that built it is complete (`gto_agg_progress`: turn 3,184,083 rows done, river 5,672,256 rows done, both `done: true`). The engine never reads the 80 GB warehouse at runtime.

---

## PART 4. Complete state inventory (verified 2026-10-05 23:20 to 23:45 UTC)

### 4.1 Data

| Object | Value | Check |
|---|---|---|
| `solved_spots_gold` | ~8,874,421 rows (planner estimate), 80 GB | `select reltuples::bigint from pg_class where relname='solved_spots_gold'` |
| Provenance columns on warehouse rows (`solver_version`, `solver_binary_checksum`, `machine_id`, `pipeline_commit`, `manifest_*`, `quality_status`) | NULL on every row of an ~18,300-row TABLESAMPLE | Part 9 |
| Rows with `strategy_matrix_v2` | ~21% of the sample (3,939 of 18,325) | Part 9 |
| Keys present in `strategy_matrix_v2` (5,745 sampled rows) | hero, node, rake, board, pot_bb, solver, street, actions, ev_ip_bb, position, ev_oop_bb, ip_player, oop_player, combo_order, frequencies, hand_evs_bb, eff_stack_bb, tree_geometry, exploitability_pct (and `pot` on 26 rows) | Part 9 |
| Keys V31 needs that are ABSENT from every sampled row | `action_evs_bb`, `matchups`, `policy_evs_bb` in v3 form, `node_context`, `line_proof`, checksums | Part 9 |
| `gto_postflop_v31` (legacy per-combo store) | 6,394 cells built from 1,891,817 v2 rows; NOT loaded by the live brain | It cannot tell an open node from a response node; retired by migration `20260908181657_the_horse_reads_only_a_certified_solver_dataset.sql` |
| `gto_combo_map` | 1,326 rows | Not a substitute for the binary's `show_hand_order` capture |
| `solver_status` (legacy) | M1 last update 2026-09-10 17:34 UTC, M2 2026-08-16 00:38 UTC, both "no work found" | `select * from solver_status` |
| `solver_manifest` | 5 legacy phase manifests (6max cash flop+turn, stack ladder 20/40/60/80/100/200bb, range files `RFI_<seat>_<depth>.txt`) | `select id from solver_manifest` |
| `solver_pipeline` | 13 stored legacy scripts (orchestrate.py, watchdog.py, run_machine.py, pio_harvest.py, tree_gen.py, make_ranges.py, ...) | Useful to learn how M1/M2 were set up (Windows Scheduled Task runs watchdog.py every 10 min) |

### 4.2 Infrastructure

| Item | State | Check |
|---|---|---|
| World Hub gateway route | Deployed. Unsigned POST returns HTTP 401 `{"success":false,"error":"Invalid V31 gateway request"}` (2026-10-05 ~23:45 UTC) | `curl -s -X POST -H 'content-type: application/json' -d '{}' https://smarter.poker/api/internal/horse-solver-v31 -w '\nHTTP %{http_code}\n'` |
| Gateway source | `pages/api/internal/horse-solver-v31.js`, `src/lib/horses/solverV31IngressAuth.mjs`, tests `__tests__/horse-solver-v31-ingress.test.mjs`, `__tests__/horse-solver-v31-pipeline.test.mjs` (World Hub) | `git ls-tree -r --name-only origin/main \| grep -i solver` |
| V31 HMAC secrets in Vercel | All three present in production and preview, set 2026-09-29 | Vercel env listing, names only |
| Producer scripts | World Hub `scripts/horse-solver-v31/`: README.md, contract.py, gateway.py, pio_upi.py, prepare_bundle.py, worker.py, compactor.py, test_pipeline.py, manifest.disabled.example.json, range-bundle.disabled.example.json | `git show origin/main:scripts/horse-solver-v31/README.md` |
| Approval function | `ca_gto_v31_approve_input_bundle(p_bundle jsonb)`, EXECUTE granted to `authenticated` only, requires horse admin | Part 9 |
| Engine release live | `20b8acb5f68c551daddbdce1ac1764b41f448f64` (2026-10-05 22:55 UTC). Unrelated to V31; recorded so you can tell your own release apart | `curl -s https://engine.smarter.poker/health` -> `releaseSha` |

### 4.3 Shipped by the previous session (context only, NOT V31)

PR #6170 (merge `7acd3ec2b5`) and PR #6180 (merge `20b8acb5f6`) changed horse strategy and the daily audit. They are live and verified. They do not touch V31. Do not revert them.

---

## PART 5. The task that blocks everything else: reach M1 and M2

### 5.1 Already proven: the warehouse cannot become V31 data

`fn_gto_v31_source_node_valid` accepts only schema `smarter-poker.pio-policy.v3` and requires, for all 1,326 combos:
- `action_evs_bb`: an EV per ACTION (Pio `calc_ev PLAYER node:action`);
- `matchups`: the matchup-mass vector (`calc_ev`'s second vector);
- `policy_evs_bb` equal to sum(frequency x action EV) within 0.02 for every combo with weight > 0;
- `node_context` (16 keys), `line_proof` (7 keys), `source_combo_order_checksum`, `range_bundle_checksum`, and a node checksum PostgreSQL recomputes.

The warehouse's v2 rows have only `hand_evs_bb` (one EV per combo for the whole node) and no matchup vector. Per-action EVs cannot be reconstructed from frequencies. Conclusion: V31 needs a FRESH v3 harvest on M1 and M2. Do not re-litigate this unless you find v3 data the previous agent missed. If you think you have, prove it with `fn_gto_v31_source_node_valid` on one real row before you build anything.

### 5.2 Not done: access to the hosts

Checked and NOT found on 2026-10-05: no M1/M2 entry in the Mac Studio's `~/.ssh/config`, no Windows host in its ARP table (LAN 10.1.10.0/24), no Tailscale, no remote-desktop setup documented in either repo, no linked Claude session on either host.

Dan was asked how to reach them and did not choose an option. Ask him exactly once, in one message, with these three options:
1. Install your agent's remote runner (or the Claude desktop app) on each Windows host, so you get a shell there. Recommended.
2. Remote desktop or SSH: he names the tool and WHERE the login is stored (a password manager entry, never pasted in chat).
3. They are cloud VMs: he names the provider; you find them in its console.

- If he picks 1: run the host steps in 5.4 yourself.
- If he picks 2 or 3: confirm you can open a session, then run 5.4.
- If he does not answer: do everything in 5.3, write the exact PowerShell for 5.4 into `docs/` as a runbook, and stop there. Do NOT claim V31 is commissioned.

### 5.3 Host-independent work (do this now, while waiting)

1. Read World Hub `scripts/horse-solver-v31/README.md`, `contract.py`, `prepare_bundle.py`, `worker.py` and `compactor.py` end to end. Run `python scripts/horse-solver-v31/test_pipeline.py` and the two World Hub `__tests__/horse-solver-v31-*.test.mjs` suites. Record the pass counts.
2. Design the FIRST dataset narrowly enough to finish: NLH cash (`game_family cash`, `objective cash_ev`, `utility_context cash_ev`), 6-max, SRP, 100bb (`depth_bucket` 80 or 150 per the validator's buckets: 10, 20, 40, 80, 150), flop `cbet` and `facing_bet` roles first. Cash scenarios use `icm_model_id: null`. Find out from `prepare_bundle.py`/`contract.py` whether an ICM model bundle file is still required when every scenario is cash; do not guess.
3. Build the range bundle. The legacy `make_ranges.py` (stored in `solver_pipeline`, name `make_ranges.py`) deterministically generates the 1,326-weight `RFI_<seat>_<depth>.txt` and `BBflat_vs_<seat>_<depth>.txt` files the legacy phases used. Reuse it, then write a range-bundle JSON with file receipts in the format of `range-bundle.disabled.example.json`.
4. Draft the manifest from `manifest.disabled.example.json`: every compact context must have targets on BOTH hosts (M1 = train, M2 = holdout), and their board-rank signatures must be DISJOINT. Suit-isomorphic copies are rejected as fake holdout. Use `fn_gto_v31_board_rank_signature(board)` to check disjointness before you write the file.
5. Leave `combo-order.txt`, the Pio version string and `APPROVED_PIO_BINARY_CHECKSUM` EMPTY. They must come from the licensed binary (5.4). Do not fill them from `gto_combo_map` or memory.
6. Commit the draft inputs under a reviewed path in World Hub on an owned branch, then PR. The manifest stays `enabled: false` until the host values exist.

### 5.4 Host steps (on EACH of M1 and M2)

1. Find the licensed console executable the legacy `run_machine.py` used (`PIO_EXE`). Compute its SHA-256 (`Get-FileHash -Algorithm SHA256 <path>`). M1 and M2 must report the same binary checksum and version, or you must stop and find out why.
2. Capture `show_hand_order` from that exact binary into `combo-order.txt`, byte for byte (the worker attests it again at startup). Capture `show_version`.
3. Stop the legacy Scheduled Task that runs `watchdog.py` so the retired direct-database harvester cannot start again. Record what you disabled. Do not delete its data directory.
4. Clone World Hub at the approved commit (it must already be on `origin/main`). Place the approved inputs at a fixed path (for example `C:/approved/inputs`).
5. Run the preflight. It contacts no gateway and writes nothing:

```powershell
python scripts/horse-solver-v31/worker.py M1 `
  --manifest C:/approved/v31-manifest.json `
  --input-root C:/approved/inputs `
  --preflight-only
```

   Do the same on M2 with `M2`. Both must pass before any secret is installed.

### 5.5 After both preflights pass

1. On the Mac, from a clean checkout of the approved commit, run `prepare_bundle.py` (README step 1). It prints checksums and writes `"approved": false`.
2. Approval: the approval JSON goes UNCHANGED to `ca_gto_v31_approve_input_bundle` through an authenticated horse-admin session. The returned UUID and checksum must equal what the preparer printed. If the only admin session available is Dan's, Dan's "always yours" covers operating it, but you may not impersonate or forge a session. If no admin session is usable, that is a real blocker: say so and stop.
3. Install the HMAC secrets: compactor key on the compactor host, M1 key on M1, M2 key on M2, as `HORSE_SOLVER_V31_HMAC_SECRET`. If you cannot confirm the host copies match the 2026-09-29 Vercel values, rotate all three (Part 2.3) and redeploy the gateway.
4. Register: `python scripts/horse-solver-v31/compactor.py --manifest ... --input-root ...`. Exit code 2 = registered, waiting for workers. Verify one row in `gto_v31_datasets`.
5. Run each worker (README step 5) with `--work-directory C:/solver-state/v31` and the six environment variables. Watch `solver_worker_heartbeats` and `gto_v31_source_artifacts` grow, separately for M1 and M2.
6. Run the compactor again to build and seal. It refuses to seal unless train evidence, holdout evidence, full coverage, source receipts, error thresholds and provenance all pass. A refusal names its reason. Fix the input, never the gate.
7. Club Arena: `cd server && npm run horse:gto-v31-evaluate -- --dataset=<uuid>` writes eight receipts and leaves the dataset in `candidate`. Show Dan the receipts.
8. Promote: the same command with `--promote`. Then verify Part 9.4 on the LIVE engine.

---

## PART 6. Backlog (V31 only)

HIGH
- Host access (5.2). Done = you can run commands on both M1 and M2.
- First certified dataset end to end (5.3 to 5.5). Done = one row `state='active'` in `gto_v31_datasets`, runtime cells loaded by the live engine, `v31_*` certified telemetry firing (Part 9.4).

MEDIUM
- Daily audit noise: the 2026-09-27 migration `20260927220533_uncommissioned_solver_pipeline_is_not_an_outage.sql` downgraded "worker missing" to an info note while the pipeline is uncommissioned. Once workers run, check that `fn_audit_solver_pipeline_liveness` reports real liveness again and that a dead worker would page.
- `docs/SOLVER-DATABASE.md` (Club Arena) and the 2026-09-27 migration comment still say the hosts and secrets do not exist. Correct them in the same PR that lands your first real artifacts, with the evidence.

LOW
- Extend coverage after the first dataset: turn/river, other positions, 3-bet pots, then ICM families (need the reviewed ICM model bundle).

Done differently than specified: none yet.

DECLINED, do not build:
- Converting `solved_spots_gold` v2 rows into v3 nodes (5.1). If a future agent "fixes" V31 by synthesizing `action_evs_bb` or `matchups`, that is a mistake.
- Re-enabling the legacy `gto_postflop_v31` store or the direct-database Windows workers.

BLOCKED on a human:
- Dan's answer on how to reach M1/M2 (5.2).
- An authenticated horse-admin session for the approval call (5.5 step 2).

---

## PART 7. Defects found so far, and their lessons

1. Symptom: an agent stated "M1 and M2 do not exist yet" and "the World Hub gateway holds none of the three HMAC secrets". Cause: it trusted a 2026-09-27 migration comment. Reality: the machines ran until 2026-09-10, and the secrets were added 2026-09-29. Lesson: a comment is a snapshot. Re-measure the estate before you assert its state.
2. Symptom: "the data is already stored, use it" versus a validator that rejects it. Cause: two different schemas (v2 frequencies plus per-combo EV, versus v3 per-action EV plus matchups). Lesson: check the validator's required keys against real rows before you plan a migration of data.
3. Shared shape: both mistakes are confident statements about state that nobody measured. The fix is the same: run the query, then speak.

---

## PART 8. Traps and instruments that lie

- `pg_class.reltuples` is an ESTIMATE. Never `count(*)` `solved_spots_gold` (80 GB) in a request path; use `TABLESAMPLE SYSTEM (0.2)`.
- Merged is not deployed, and deployed is not loaded. The engine loads V31 cells only after a dataset is PROMOTED, and only through `fn_gto_v31_active_cells`. Prove it on the running container (Part 9.4).
- `gto_combo_map` looks like the combo order. It is not the attested `show_hand_order` of the licensed binary.
- The gateway answering 401 proves it is DEPLOYED, not that any host can sign to it.
- Vercel sensitive variables show their names but never their values. A present name does not prove the hosts hold the same value.
- A compactor exit code 2 is SUCCESS (registered, waiting), not a failure.
- GitHub Actions had a runner outage on 2026-10-05 (about 19:00 to 22:00 UTC). Jobs it killed show `cancelled` with an empty runner name, or "The runner has received a shutdown signal". Those are not test failures: rerun with `gh run rerun <id> --failed` once the run completes.

---

## PART 9. Verification commands

### 9.1 V31 progress (SQL, project kuklfnapbkmacvwxktbh)

```sql
select (select count(*) from gto_v31_input_bundles where approval_status='approved') approved_bundles,
       (select jsonb_agg(jsonb_build_object('id',dataset_id,'state',state,'quality',quality_status)) from gto_v31_datasets) datasets,
       (select jsonb_object_agg(machine_id, n) from (select machine_id, count(*) n from gto_v31_source_artifacts group by 1) s) artifacts_by_host,
       (select count(*) from gto_v31_runtime_cells) runtime_cells,
       (select jsonb_object_agg(machine_id, last) from (select machine_id, max(received_at) last
          from solver_worker_heartbeats group by 1) h) last_worker_hb_by_host;
```
Healthy during a harvest: artifacts grow on BOTH M1 and M2, and heartbeats are minutes old.

### 9.2 Warehouse facts (re-prove Part 5.1)

```sql
select k, count(*) from (select jsonb_object_keys(strategy_matrix_v2) k
  from solved_spots_gold tablesample system (0.3) where strategy_matrix_v2 is not null) x group by k order by 2 desc;
-- Expect no action_evs_bb and no matchups.
```

### 9.3 Approval function guard

```sql
select proacl::text, prosrc like '%fn_is_horse_admin%' needs_admin from pg_proc where proname='ca_gto_v31_approve_input_bundle';
-- Expect {postgres=X/postgres,authenticated=X/postgres} and true.
```

### 9.4 Live proof after promotion

```bash
curl -s https://engine.smarter.poker/health | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['releaseSha'],d['uptime'])"
ssh -i ~/.ssh/hetzner_deploy_ed25519_new root@5.161.252.33 'docker logs club-arena-engine --since 2h 2>&1 | grep GtoPostflopV31Loader | tail -3'
# Expect: "[GtoPostflopV31Loader] <n> certified solver cells loaded" with n > 0.
```
```sql
select feature, fires from horse_brain_telemetry where day=(now() at time zone 'utc')::date and feature like 'v31%' order by fires desc;
-- Expect certified V31 counters firing after the next refresh. A gto_miss_* or v31_*_skip_* rise
-- names coverage gaps; read the reason, do not hide it.
```

### 9.5 Build gates before any PR

- World Hub: its own test suite plus `python scripts/horse-solver-v31/test_pipeline.py`.
- Club Arena: `cd server && npx tsc --noEmit && npx vitest run` (2026-10-05 baseline: 20,238 passed, 0 failed, 168 skipped), and the pre-push hook must pass.

---

## PART 10. File map

| Path | What | Status |
|---|---|---|
| World Hub `scripts/horse-solver-v31/worker.py` | Windows host worker (Pio UPI, v3 artifacts, signed upload) | Built, never run |
| World Hub `scripts/horse-solver-v31/compactor.py` | Register / build / seal (compactor key) | Built, never run |
| World Hub `scripts/horse-solver-v31/prepare_bundle.py` | Writes final manifest and approval JSON | Built, never run |
| World Hub `scripts/horse-solver-v31/contract.py`, `gateway.py`, `pio_upi.py` | Shared contract, signing client, Pio transport | Built |
| World Hub `pages/api/internal/horse-solver-v31.js` + `src/lib/horses/solverV31IngressAuth.mjs` | Signed ingress gateway | LIVE (401 to unsigned) |
| Club Arena `server/src/services/GtoPostflopV31Loader.ts` | Loads promoted certified cells | LIVE, loads 0 |
| Club Arena `server/src/scripts/gtoV31Evaluate.ts` (`npm run horse:gto-v31-evaluate`) | Paired replay + league receipts, `--promote` | Built, never run |
| Club Arena `docs/SOLVER-DATABASE.md` | Solver architecture | Partly stale (Part 6) |
| Club Arena `supabase/migrations/20260908181657_the_horse_reads_only_a_certified_solver_dataset.sql` | Certified-only release path | Installed |
| Club Arena `supabase/migrations/20260927220533_uncommissioned_solver_pipeline_is_not_an_outage.sql` | Audit treats uncommissioned as a note | Installed; revisit (Part 6) |
| Supabase `solver_pipeline` rows | Legacy host scripts (watchdog, orchestrator, harvester, ranges) | Reference only, do not revive |
| Club Arena `scripts/windows_piosolver/README.md` | Tombstone for retired direct-DB workers | Keep |

---

## PART 11. How to behave

- Measure, then speak. Every number you report carries what was measured and when.
- Read real output before you believe a test or a tick. Merged, deployed and loaded are three different facts.
- Fix at the source. A gate that refuses your data is telling you the data is wrong; fix the input, never the gate.
- Fail closed. If any provenance value is unknown, stop and get the real value.
- Write your own changelog in `docs/changelog/` of the repo you change, with the commands you ran and their results.
- Say what you could not verify, in so many words.
- Ask Dan only for what you genuinely cannot obtain yourself, once, precisely.

---

## PART 12. Opening moves, in order

1. Run Part 2.2. If any V31 count is non-zero, stop and find out who started.
2. Read Club Arena `AGENT-PLAYBOOK.md`, `docs/agent-policy/*` and `PUBLISHING.md`, then World Hub `scripts/horse-solver-v31/README.md`, in full.
3. Re-prove Part 5.1 with Part 9.2 (two minutes). Do not spend longer on it.
4. Ask Dan the single access question in Part 5.2.
5. While waiting, do Part 5.3 items 1 to 4 and open the World Hub PR with the draft inputs (`enabled: false`).
6. When you have host access, do Part 5.4 on M1 and M2, then 5.5 through evaluation.
7. Show Dan the candidate receipts, promote, then prove Part 9.4 on the live engine.

You do not fabricate solver provenance, ever: no synthesized EVs, combo orders, checksums or approvals. If the real value is not in hand, V31 stays uncommissioned and you say so.
