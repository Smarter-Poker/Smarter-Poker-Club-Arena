# 2026-08-15 — SECURITY INCIDENT: root compromise of the engine host

**Severity: critical. Assume every secret on engine-01 is compromised.**

Found while investigating what looked like ordinary CPU saturation on the
Hetzner game server (`178.156.160.206`, `engine.smarter.poker`). The load was
not capacity — it was a cryptominer that had been running as root for 28 days.

## What was found

|               |                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Malware       | XMRig Monero miner, disguised as `systemd-bench`                                                                               |
| Location      | `/root/.system-cache/systemd-bench` (+ `/root/.system/install_bench.sh`)                                                       |
| SHA256        | `b20f39fc00d242e706b6c30367ad811c676e0575050a4ec2f30104b696944b49`                                                             |
| Running since | 2026-07-18 15:51 — **28 days**, 184% CPU on a 2-vCPU box                                                                       |
| Installed     | 2026-05-24 14:33                                                                                                               |
| Pool / wallet | `pool.supportxmr.com:443`, `4ABnCJEm7Umfip66JRPJ35JtdDkM6BWrA1JqXMDMfQaVVxECJS584THY6cm4y6STLDW9H5fAGoCpebvYrj3PKWy6DiXd75r`   |
| Persistence   | root crontab: `@reboot` + `*/30 * * * *` → `/etc/xmrig-restore/restore.sh` (full reinstaller, 28KB, Russian-language comments) |
| Backdoors     | 4 attacker SSH keys in `/root/.ssh/authorized_keys`: `<no comment>`, `ovh-vps`, `aws-1`, `hetzner-access`                      |

## Entry vector

`PasswordAuthentication yes` in `/etc/ssh/sshd_config`, against a firehose of
brute force: **36,377 failed password attempts** in the current `auth.log`
alone. The successful root login came from `82.162.122.42` on
**2026-05-24 14:31–14:33** — the exact minutes `/etc/xmrig-restore/` was
created. Repeat root logins followed from `185.161.168.163`, `185.161.169.69`,
`77.35.57.141`, `185.161.171.58`.

## They were hunting cloud credentials, not just mining

From `/root/.bash_history` (translated from Russian comments):

```
# Check if vercel cli exists
which vercel || npx vercel --version
# If there is a token
cat ~/.vercel/credentials.json
cat /root/.vercel/credentials.json
# Or in env
env | grep VERCEL
```

This is the part that matters. The box holds `/opt/club-arena/server/.env`,
which contains the **Supabase SERVICE ROLE KEY** — full database access that
bypasses RLS. An attacker with root for three months had unrestricted access to
that file.

## Containment performed (2026-08-15 ~20:27–20:30 UTC)

Evidence was preserved to `/root/incident-20260815/` **before** anything was
touched: config, binary hash, bash history, original `authorized_keys`, original
crontab, login history, process table, connections, auth log tail.

1. Removed the cron persistence **first**, so the reinstaller could not fire
   during cleanup.
2. Quarantined `/etc/xmrig-restore/` and both miner directories into the
   evidence folder (moved, not deleted — kept for forensics).
3. Killed the miner (PID 1855). Pool connections → 0.
4. Removed the 4 attacker SSH keys. Kept 3 verified-legitimate keys
   (`smarter.poker@deploy`, `openclaw-dispatcher`, `cowork-claude@vm`),
   confirmed by fingerprint against the keys on Dan's Mac.
5. **Disabled SSH password authentication** — the entry vector. Key auth
   verified working before and after; sshd config validated before reload.
6. Installed and enabled **fail2ban** (aggressive sshd jail, 4 retries, 24h
   ban). It banned 3 hosts within seconds of starting.

**Result:** load average 2.25 → 0.64. Engine unaffected throughout
(`liveness: ok`, 21 tables dealing).

## STILL REQUIRED — owner action (cannot be done from here)

1. **Rotate the Supabase service role key and anon key.** Highest priority.
   Assume the current ones are in attacker hands.
2. **Rotate every other secret in `/opt/club-arena/server/.env`.**
3. **Rotate the Hetzner SSH keys** and the GitHub PAT.
4. **Strongly consider rebuilding the host.** A box with three months of root
   compromise cannot be proven clean by inspection. Cleaning removes what was
   found; a rebuild removes what was not.
5. Check the Vercel account for unrecognised tokens or deployments — they were
   explicitly hunting for Vercel credentials.

## Database review

No evidence of financial abuse found in a first pass: zero admin-type wallet
credits since 2026-05-24, only 6 profiles created in that window. This is not a
clean bill of health — a service-role actor could write without leaving an
obvious signature — but nothing anomalous surfaced.

## Relationship to the table freezes

The miner consumed ~184% of a 2-vCPU box for 28 days. The engine's turn clocks
run on a shared `DeadlineScheduler` tick with a 20ms budget; sustained CPU
starvation makes tick lateness materially more likely. It is not the root cause
of the freeze defects fixed today — those were real logic bugs with specific
traces — but it plausibly increased their frequency, and it explains why
`HostCPUSaturated` had been firing (into a null-receiver, unseen).
