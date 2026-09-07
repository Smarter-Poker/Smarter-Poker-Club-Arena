# Table Voice TURN Relay -- operator runbook

Status as of 2026-08-27: **the repo-side half is built and shipped. No relay
host has been chosen, and nothing has been installed.** Every engine answers
`GET /voice/ice` with the STUN-only list today, and voice behaves exactly as it
did when it shipped. Nothing in this document has been run against a server.

Read the co-tenancy section before anything else. The obvious candidate host is
shared with an unrelated business, and a misconfigured relay on a shared box is
not a voice bug, it is a way into somebody else's production.

---

## 1. Why a relay exists

Table voice is a peer-to-peer WebRTC audio mesh signalled over Supabase
Realtime, on public STUN only. That has two consequences, and neither is
cosmetic.

**Symmetric NAT.** STUN reports the public address a peer is reachable at. It
cannot help when the NAT allocates a _different_ external port per destination,
which is what symmetric NAT does and what most mobile carrier networks are. Those
players do not get worse audio. They get none: ICE exhausts its candidate pairs
and the connection reaches `failed`. The mesh already says so out loud
(`peerStates[id] === 'failed'`, error code `connection-failed`) rather than
leaving a microphone that looks alive, but saying so is not fixing it.

**IP exposure.** An ICE candidate _is_ an IP address. In a p2p mesh every
participant hands theirs to every other participant, by design, because that is
how the media path is established. At a real-money poker table full of strangers
that is not a networking detail: an address identifies a household, geolocates
to a town, and is the first step of both the collusion question ("are seats 3 and
7 in the same flat?") and the harassment one.

A TURN relay closes both. A relayed candidate carries the **relay's** address, so
a peer's own address never leaves the relay, and the relay is reachable from
behind any NAT because the client dials out to it.

---

## 2. Shared Infrastructure Risk

The engine host is `engine.smarter.poker` (5.161.252.33), named
`club-arena-engine` in Hetzner and the OS as of 2026-09-07. It runs the poker
engine container, Caddy, and the monitoring stack. The retired application is
absent and its obsolete deployment configuration has been removed. The TURN
relay already has its own host, `club-arena-turn`; keep that separation.

CPU, bandwidth, firewall rules and internal HTTP services remain resources
that an installation must protect. `scripts/install-turn-relay.sh` records
**every** running service before installation and checks them afterward. It
also explicitly recognizes Caddy, Docker and the engine container. Retiring an
unrelated service does not weaken those continuity checks.

Keep the relay quotas and private-address restrictions below. Firewall changes
remain additive only: never reset ufw or flush iptables. A raw nftables ruleset
is still outside the installer's ownership and must not be rewritten blindly.

### 2.1 Deny relaying to private ranges -- the single most important line

A TURN relay's job is to forward packets to wherever the client asks it to. Left
open, "wherever" includes the relay's own loopback and its own private network.
On a shared host that means a credential holder can reach, from `127.0.0.1`:

- the co-tenant's application and whatever it binds locally;
- Prometheus, Grafana and Alertmanager;
- Caddy's admin API;
- the Club Arena engine's own HTTP surface;
- anything else either tenant ever binds to localhost "because it is internal".

Nothing upstream sees any of this as external traffic, because it is not: it
arrives from the box itself. A firewall cannot help. An allowlist on the engine
cannot help. The only thing that stops it is the relay refusing the destination.

So the config carries `no-loopback-peers` plus an explicit `denied-peer-ip` block
covering RFC1918 (`10/8`, `172.16/12`, `192.168/16`), loopback (`127/8`, `::1`),
link-local (`169.254/16`, `fe80::/10`), CGNAT (`100.64/10`), unique-local IPv6
(`fc00::/7`), the multicast and broadcast range, and the IPv4-mapped IPv6 space
that would otherwise let an attacker spell a private v4 address as a v6 one.

**There is no `allowed-peer-ip` line, on purpose.** Voice peers are public
addresses. Any exception belongs in a review, not in a default.

The config also sets `no-tcp-relay`, which refuses RFC 6062 TCP allocations. That
is the classic "somebody found your TURN server and is using it as a general
purpose TCP proxy" vector, and WebRTC has no use for it -- browsers only ever
request UDP allocations. It does **not** stop a client _connecting_ over TCP:
`turn:host:3478?transport=tcp` still works, because that is the client-to-relay
leg and it is served by listening on `3478/tcp`. Players on networks that block
UDP outright keep their path; the proxy abuse does not.

### 2.2 The honest alternative

A separate small host removes shared CPU, shared bandwidth, shared firewall and
the entire co-tenancy blast radius in one step, and a relay is the workload most
suited to being separate: it holds no state, needs no database, and its failure
mode is "voice stops", not "poker stops".

That is a decision for the product owner, not for an agent: CLAUDE.md section
1.1.1 (RULE 12) forbids agents from creating new infrastructure. Both options
are viable with this config. The shared option needs section 2.1 to be exactly
right; the separate option needs a new host to exist.

---

## 3. What gets installed

`scripts/install-turn-relay.sh`, run as root on the chosen host. It is
idempotent -- re-running it is safe and changes nothing that is already correct.
Run it with `--dry-run` first; it prints every change it would make and exits 0.

```bash
sudo bash scripts/install-turn-relay.sh --dry-run
sudo bash scripts/install-turn-relay.sh --public-ip <address clients reach>
```

| Thing                                                                  | Where                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------- |
| `coturn`, from the Ubuntu archive (no third-party repo, no new vendor) | `apt`                                              |
| The relay config                                                       | `/etc/turnserver.conf`, mode 0640, root:turnserver |
| `TURNSERVER_ENABLED=1` (Ubuntu ships the daemon disabled)              | `/etc/default/coturn`                              |
| The static auth secret, **generated on the host at install time**      | `/root/club-arena-turn-secret`, mode 600           |
| Firewall ALLOW rules                                                   | ufw, if ufw is the manager                         |
| The systemd unit, enabled so it survives reboot                        | `coturn.service`                                   |

The secret is never in the repository, never in the script, and never printed
unless you pass `--print-secret`. Stdout ends up in scrollback and in CI logs.

Re-running the script **reuses** an existing secret rather than minting a new
one. Rotating silently would invalidate every credential the engine has already
handed out and kill voice for everyone currently in a room. Rotation is section 7.

---

## 4. The configuration, line by line

### Identity and listeners

| Line                                           | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `realm=smarter.poker`                          | The authentication realm the client is challenged with. It must match nothing in particular, but it must be stable: changing it invalidates in-flight credentials.                                                                                                                                                                                                                                                                                                        |
| `listening-port=3478`                          | The IANA TURN port. Both UDP and TCP.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `listening-ip=<interface address>`             | Bind to the real interface, not `0.0.0.0`, so the relay does not accidentally answer on an interface it was not meant to.                                                                                                                                                                                                                                                                                                                                                 |
| `external-ip=<public>` or `<public>/<private>` | **The field most often wrong.** coturn advertises whatever it _bound_ unless told otherwise. On a host whose interface holds a private address behind a public one (cloud NAT, floating IP), clients are told to send media to an address that does not exist on the internet. Allocations then succeed and no audio ever arrives, which is the hardest failure of the lot to diagnose. The script auto-detects and refuses to guess when the primary address is private. |

### Authentication

`use-auth-secret` + `static-auth-secret=<generated>` is the coturn REST scheme
(draft-uberti-behave-turn-rest-00). The engine mints:

```
username   = <unix-expiry-timestamp>:<userId>
credential = base64( HMAC-SHA1( username, static-auth-secret ) )
```

and coturn recomputes the same HMAC from the username it is handed, then refuses
the allocation if the timestamp has passed. **No user records exist on the
relay.** It has never heard of any player, and every credential expires on its
own. The engine's half is `server/src/voice/turnCredentials.ts`; the derivation
is pinned against the published vector in
`tests/unit/voiceIceCredentials.test.ts`.

HMAC-**SHA1** is correct and is not a defect. Its security rests on the secret,
not on SHA-1's collision resistance, and the algorithm is fixed by what coturn
computes on the other side. Changing it to SHA-256 makes nothing stronger; it
makes every credential invalid.

### Relay port range

`min-port=49152`, `max-port=53247` -- 4096 ports, a quarter of coturn's default 16384. The arithmetic:

- a nine-seat table is a full mesh, so each player holds 8 peer connections:
  9 x 8 = **72 relay allocations** for one full table;
- browsers use rtcp-mux so one allocation is one port; allow 2x headroom for a
  client that does not, and for the TCP variant: **about 144 ports per table**;
- 4096 / 144 is roughly **28 simultaneous nine-handed voice tables**.

Far past anything this platform has seen, on a quarter of the default firewall
surface. If that ceiling is ever reached, raise `--max-port` **and** the firewall
rule together -- they are two halves of one change, and doing one without the
other produces allocations that succeed and then silently drop.

### Quotas

| Line                          | Why                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user-quota=2000` (kbit/s)    | Opus speech is ~24-40 kbit/s per stream; a player in a nine-handed relayed mesh needs about 640 kbit/s at the worst. 2 Mbit/s is generous headroom and still makes a stolen credential worthless for anything but talking -- nobody proxies video, a download or a botnet through it. |
| `total-quota=200000` (kbit/s) | The whole-relay cap, deliberately well under the NIC. **On a shared host this is the line that stops a busy night starving the co-tenant.**                                                                                                                                           |
| `max-allocate-lifetime=3600`  | The longest lifetime granted per allocation before the client must refresh. An abandoned allocation (a closed tab, a phone in a tunnel) releases its port within the hour instead of holding it.                                                                                      |
| `stale-nonce=600`             | Forces periodic re-authentication, so an expired credential stops working on the next nonce rather than whenever the client happens to reconnect.                                                                                                                                     |

### Hardening

| Line                             | What it prevents                                                                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `no-cli`                         | coturn's telnet CLI listens on 5766 and has historically shipped with a default password. There is no reason for it to exist here.                                                                                                                           |
| `no-multicast-peers`             | A relay that will forward to a multicast group is an amplifier pointed at somebody else's network.                                                                                                                                                           |
| `no-loopback-peers`              | Reaching services bound to `127.0.0.1` on this box. See section 2.1.                                                                                                                                                                                         |
| `denied-peer-ip=...` (15 ranges) | Reaching anything on the private network. See section 2.1. This is the most important block in the file.                                                                                                                                                     |
| `no-tcp-relay`                   | RFC 6062 TCP allocations, i.e. using the relay as a general TCP proxy. See section 2.1.                                                                                                                                                                      |
| `fingerprint`                    | Message-integrity fingerprinting, as WebRTC clients expect.                                                                                                                                                                                                  |
| `lt-cred-mech`                   | Long-term credential mechanism. Anonymous allocations are refused outright.                                                                                                                                                                                  |
| `syslog` + `simple-log`          | Logs go to journald, so they rotate with everything else and cannot fill a disk the co-tenant is also using. coturn's own log-file rotation is a separate scheme and has filled disks before.                                                                |
| no `verbose`                     | Verbose coturn logs every allocation **with its username**, and a REST username is `<expiry>:<userId>` -- so verbose mode writes a per-player activity log to disk. Turn it on for a debugging session, turn it off again, and say so in the incident notes. |

### What is deliberately not configured

**TURNS (TLS, port 5349).** It would need a certificate on a host whose Caddy
already serves the co-tenant's sites -- a change to _their_ TLS setup -- and it
buys little: WebRTC media is already DTLS-SRTP end to end, so the relay forwards
ciphertext it cannot read either way. The only thing TLS adds is hiding the fact
that a TURN connection exists. Revisit only if a network that blocks all
non-443 traffic makes it necessary.

**IPv6 relaying.** Voice does not need it, and a second address family is a
second copy of every deny rule to get exactly right.

---

## 5. Firewall

Three rules, all ALLOW, all added and never removed:

```
3478/udp                 TURN, client to relay
3478/tcp                 TURN, client to relay (networks that block UDP)
49152-53247/udp          the relay port range
```

If the provider has an upstream firewall (Hetzner Cloud firewalls, a security
group), **the same three rules must exist there too**. The script cannot see an
upstream firewall and will tell you so. The symptom of getting only one layer
right is stage 7 reporting "ALLOCATION WAS NOT GRANTED".

---

## 6. Expected bandwidth

Opus mono speech is ~24-40 kbit/s. Use **40 kbit/s** per stream to include
RTP/UDP/IP headers and SRTP overhead.

In a relayed full mesh of N players, each player uploads N-1 streams to the relay
and downloads N-1 from it, so relay throughput is `2 x N x (N-1) x 40 kbit/s`.

| Case                                                                    | Streams | Throughput  | Per table hour |
| ----------------------------------------------------------------------- | ------- | ----------- | -------------- |
| Ceiling: nine-handed, everyone talking at once                          | 144     | 5.8 Mbit/s  | **~2.6 GB**    |
| Realistic: nine-handed, one speaker at a time, talking ~30% of the time | ~5      | 0.19 Mbit/s | **~0.09 GB**   |
| Six-handed, one speaker, ~30%                                           | ~3      | 0.12 Mbit/s | **~0.05 GB**   |

The realistic figure is the one to plan with, and the reason it is 30x below the
ceiling is a design decision, not luck: **the microphone starts muted and the
local track starts disabled**, so a player who is not talking is not encoding.
Nine people talking over each other for a full hour is not a poker table.

Plan on **~0.1 GB per table hour**, with a hard ceiling of 2.6. A hundred
table-hours a day is roughly **10 GB/day, 300 GB/month** -- comfortably inside a
Hetzner traffic allowance, but remember the co-tenant shares it, and the ceiling
case (7.8 TB/month at a hundred table-hours a day) is the number that would not
be. `total-quota` is what makes the ceiling unreachable.

---

## 7. Rotating the secret

Rotation is deliberate and never automatic. **Rotating invalidates every
credential the engine has already handed out**, so everyone currently in a voice
room loses their peers when their connections next renegotiate.

Do it during a quiet window, in this order:

1. Generate and place the new secret on the relay:
   ```bash
   NEW=$(openssl rand -base64 48 | tr -d '\n')
   printf '%s' "$NEW" > /root/club-arena-turn-secret
   chmod 600 /root/club-arena-turn-secret
   sed -i "s|^static-auth-secret=.*|static-auth-secret=${NEW}|" /etc/turnserver.conf
   systemctl restart coturn
   ```
2. Put the same value in the engine's environment (section 8) -- `TURN_STATIC_AUTH_SECRET`
   in `/opt/club-arena/server/.env`.
3. Let the **next natural deploy** pick it up. Do not restart the engine by hand
   under live hands.

Between steps 1 and 3 the engine mints credentials against the old secret and
the relay refuses them, so voice falls back to failing honestly rather than
silently. Keep that window short, or do step 2 first and accept the mirror-image
window instead -- either way, one of the two windows exists and the fix is to
pick the quiet hour, not to try to eliminate it.

Rotate if: the secret file is ever read by someone who should not have it, the
host is rebuilt, or an allocation shows up in the logs that no player explains.

---

## 8. Deploying the secret to the engine (nothing restarts)

The engine container receives its environment from a single file on the host:

```
/opt/club-arena/server/.env
```

`.github/workflows/auto-deploy-hetzner.yml` passes it as
`ENV_FILE=$REPO_DIR/server/.env` to `server/scripts/engine-up.sh`, which runs
`docker run --env-file "$ENV_FILE"`. That file is **not** in the repository and
is never touched by a deploy -- the deploy's pre-flight step only asserts it
exists and is non-empty.

So the change is: add these lines to `/opt/club-arena/server/.env`.

```
TURN_STATIC_AUTH_SECRET=<contents of /root/club-arena-turn-secret>
TURN_HOST=<the address clients reach>
TURN_PORT=3478
```

`scripts/install-turn-relay.sh --write-engine-env` appends them for you, taking a
timestamped backup first and refusing to overwrite an existing
`TURN_STATIC_AUTH_SECRET`.

**Nothing restarts, and that is deliberate.** A restart voids in-flight hands
(`auto-deploy-hetzner.yml` has an entire drain gate about this). The running
container keeps its old environment, so it keeps answering `/voice/ice` with the
STUN-only list until the container is recreated. The next natural deploy of
`server/**` -- or the 20-minute catch-up schedule -- picks it up in the first
window where no humans are seated.

Optional, both read by the engine, both with sane defaults:

| Variable                      | Default                                        | Meaning                                                                        |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `TURN_URLS`                   | derived from `TURN_HOST`                       | Comma-separated, if you need to state the URLs exactly. Overrides `TURN_HOST`. |
| `TURN_CREDENTIAL_TTL_SECONDS` | 14400 (4h)                                     | Credential lifetime, clamped to 5 minutes .. 12 hours.                         |
| `VOICE_ICE_TRANSPORT_POLICY`  | `relay` when a relay is configured, else `all` | The escape hatch in section 9.                                                 |
| `VOICE_STUN_URLS`             | Google + Cloudflare                            | Override the STUN list.                                                        |

---

## 9. `relay` versus `all`, and what happens when the relay dies

`iceTransportPolicy` decides whether the browser will consider a direct path.

- **`all`** (the browser default) prefers direct. Cheaper -- no relay bandwidth
  when both peers are reachable -- and it degrades gracefully, because a dead
  relay just means the direct path is the only one. It also means **every player
  learns every other player's public IP address**.
- **`relay`** forces all media through the relay. Every candidate a peer sees
  belongs to the relay, so **nobody learns anybody's address**. It costs relay
  bandwidth for every stream, and if the relay is down there is no other path.

**The engine chooses `relay` whenever a relay exists.** These are strangers
playing for money. An address leak is permanent, invisible to the player, and
cannot be undone; relay bandwidth is a line on an invoice. That is not a close
call.

**The downgrade is deliberately not automatic.** It would be easy to have the
client retry with `all` after a relay-only mesh fails, and that is exactly the
wrong thing: it would trade the privacy property away at the precise moment
nobody is watching, on every player whose relay connection hiccuped. Instead:

- with no relay configured, the answer is `all` -- forcing `relay` with nothing
  to relay through would mean voice for nobody, which is strictly worse than
  today, so the engine ignores a `relay` override in that state;
- with a relay configured but **down**, voice fails **honestly** -- the mesh
  surfaces `connection-failed` rather than a dead microphone -- and an operator
  makes the call:

  ```
  # in /opt/club-arena/server/.env, then let the next deploy carry it
  VOICE_ICE_TRANSPORT_POLICY=all
  ```

  One variable, one deploy, a decision a human made on purpose and can explain
  to a player who asks why their address was visible on Tuesday.

---

## 10. Health checks

**The only check worth trusting allocates.** "Something is listening on 3478" is
equally true of a coturn that refuses every credential, a coturn whose
`external-ip` is wrong, and a completely unrelated process. Stage 7 of the
install script does this automatically; run it by hand any time:

```bash
SECRET=$(cat /root/club-arena-turn-secret)
EXPIRY=$(( $(date +%s) + 600 ))
USER="${EXPIRY}:health-check"
PASS=$(printf '%s' "$USER" | openssl dgst -sha1 -hmac "$SECRET" -binary | base64)

turnutils_uclient -T -n 1 -c -y -u "$USER" -w "$PASS" -p 3478 <public-ip>
```

Granted allocation means the listener, the credentials, the secret, the firewall
and `external-ip` are all correct together. Nothing else proves that set.

Supporting checks:

```bash
systemctl status coturn
journalctl -u coturn -n 100 --no-pager        # allocations, refusals, quota hits
ss -lnup | grep 3478                          # the listener
ss -s                                         # total sockets, if ports look exhausted
```

And what the engine thinks, which is the other half of the pair -- the relay can
be perfect while the engine is still on the old environment:

```bash
curl -s -H "Authorization: Bearer <a player JWT>" https://engine.smarter.poker/voice/ice | jq
```

`"turn": true` means the deploy landed. `"turn": false` means the engine has not
picked up `TURN_STATIC_AUTH_SECRET` yet, which is the normal state until the
next deploy of `server/**`.

When to worry, from the journal:

| Log line                                  | Means                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| repeated `401` / `Wrong credentials`      | The engine's secret and the relay's secret disagree. Usually a half-finished rotation.                               |
| `Total server quota reached`              | `total-quota` is doing its job. Either genuine load or an abuser. Check which credentials.                           |
| `Peer address is not allowed`             | The deny list refused a destination. **Any** of these is worth reading: a browser never asks to relay to `10.0.0.5`. |
| Allocation counts far above (tables x 72) | Something is allocating that is not a poker table.                                                                   |

---

## 11. Rollback -- exact

Nothing here is irreversible, and the fallback is the behaviour voice already
ships with.

```bash
systemctl stop coturn
systemctl disable coturn

# firewall (ufw case only -- the script prints the exact list it added)
ufw delete allow 3478/udp
ufw delete allow 3478/tcp
ufw delete allow 49152:53247/udp

# restore the previous config, if there was one
ls -1 /etc/turnserver.conf.bak.* 2>/dev/null | tail -1 | xargs -r -I{} cp -a {} /etc/turnserver.conf

# or remove it outright
apt-get remove --purge -y coturn
rm -f /root/club-arena-turn-secret

# take the secret out of the engine environment, then let the NEXT natural
# deploy carry that -- do not restart the engine by hand under live hands
sed -i '/^TURN_STATIC_AUTH_SECRET=/d;/^TURN_HOST=/d;/^TURN_PORT=/d' \
  /opt/club-arena/server/.env
```

With the secret gone, `GET /voice/ice` answers the STUN-only list with
`iceTransportPolicy: "all"`, and voice returns to exactly what it shipped with.
Symmetric-NAT players cannot connect and addresses are exposed again -- the two
problems the relay exists to solve -- but nothing else changes and nothing
breaks.

**If you need voice back immediately without removing the relay**, do not roll
back: set `VOICE_ICE_TRANSPORT_POLICY=all` (section 9). That keeps NAT traversal
working via the relay while allowing direct paths, and it costs only the privacy
property, deliberately and visibly.

---

## 12. Still open -- decisions a human owns

1. **Which host.** Shared `engine.smarter.poker` (section 2 is the risk
   assessment) or a new dedicated box. An agent may not create the second one
   (CLAUDE.md 1.1.1 / RULE 12).
2. **Whether to run the install at all**, and in which maintenance window.
3. **DNS.** `TURN_HOST` can be the bare IP. A name (`relay.smarter.poker`) is
   nicer to rotate but is another record on a shared Caddy host.
4. **The upstream firewall**, if the provider has one. The script cannot see it.

Until 1 and 2 happen, the repo-side half is inert by design: the endpoint
answers, the client asks, and both agree there is no relay.

---

## Monitoring (added 2026-08-28)

Voice is relay-only, so `club-arena-turn` is a single point of failure for
voice. Nothing was watching it when it was first provisioned. It is now a
Prometheus target on the engine host's existing stack.

### Why not a port check

coturn 4.6.1 as packaged on Ubuntu 24.04 has no built-in Prometheus exporter,
and a plain "is 3478 open" probe is actively misleading here. The failure mode
that matters most is **secret drift**: if `/root/club-arena-turn-secret` on the
relay and `TURN_STATIC_AUTH_SECRET` in `/opt/club-arena/server/.env` stop
matching, the port still answers, the service still looks healthy, and the
engine hands players credentials coturn rejects. Voice then dies in a way that
looks like a network fault on the player's side.

So the probe does what a player does.

### What runs where

On `club-arena-turn` (178.156.160.206):

- `prometheus-node-exporter`, bound to the public IP, with the textfile
  collector at `/var/lib/node_exporter/textfile_collector`. Port 9100 is open
  in ufw **only** to 5.161.252.33.
- `/usr/local/bin/turn-allocation-probe.sh`, run every 2 minutes by
  `turn-probe.timer`. It mints a real short-lived HMAC credential the same way
  the engine does, performs an actual UDP allocation with `turnutils_uclient`,
  and writes `club_arena_turn_allocation_ok` (1/0) plus
  `club_arena_turn_allocation_seconds` for node_exporter to publish.
  A healthy allocation takes roughly 3.8s.

On the engine host, in `/opt/smarter-poker-monitoring/`:

- `prometheus.yml` — scrape job `turn_relay`, 30s interval.
- `alert-rules.yml` — group `turn-relay`:
  - `TurnRelayDown` (critical, 3m) — the box is unreachable. Voice is down for
    every table, not degraded.
  - `TurnRelayAllocationFailing` (critical, 5m) — up but refusing real
    credentials. This is the secret-drift alarm.
  - `TurnRelayProbeMissing` (warning, 10m) — the probe stopped reporting, so
    the auth path is unmonitored. An absent metric must never read as healthy.

Config was applied with `curl -X POST http://127.0.0.1:9090/-/reload`; the
Prometheus container has `--web.enable-lifecycle`, so no restart is needed and
the engine is never touched. Backups are written alongside as
`prometheus.yml.bak.<epoch>` and `alert-rules.yml.bak.<epoch>`.

### Checks

    # target should be up
    curl -s "http://127.0.0.1:9090/api/v1/targets?state=active" | grep turn_relay
    # allocation should be 1
    curl -s "http://127.0.0.1:9090/api/v1/query?query=club_arena_turn_allocation_ok"
    # on the relay
    systemctl status coturn turn-probe.timer prometheus-node-exporter

### Firewall note

The installer adds TURN rules but does **not** add an SSH rule and does not run
`ufw enable`. Enabling ufw after a bare install therefore locks you out. Allow
OpenSSH first. On this host that is done, and ufw is active with default deny
inbound.
