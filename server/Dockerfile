# Pin the official multi-architecture Node 22 slim manifest. A mutable base tag
# made the same protected-main SHA produce different engine bytes on rebuild.
FROM node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --include=dev --no-audit --no-fund

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npx tsc

# Remove dev dependencies
RUN npm prune --omit=dev --no-audit --no-fund

# Run
ENV NODE_ENV=production
# 2026-08-30: Node tried IPv6 first to Supabase on a host with no IPv6 route,
# burning ~40s per fresh connection while the client's deadline was 15s —
# every request on a new socket aborted as supabase_timeout and the platform
# stopped dealing. Measured in-container: 43,121ms default vs 82ms with this
# flag. Baked here so the fix survives any .env rewrite.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
EXPOSE 8080

# 2026-08-15 DEPLOY VERIFIABILITY.
# Before this, /health reported version:"local" in production — the running
# engine could not tell you which commit it was built from, so a deploy that
# silently reused a stale image was indistinguishable from a successful one.
# Baked as a build ARG (not a `docker run -e`) so the SHA is a property of the
# IMAGE: any container started from it — by the deploy, by autoheal, by the
# host supervisor — reports the same truthful value.
ARG GIT_COMMIT_SHA=unknown
ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA
# The release seal reads identity from image metadata, not from the mutable
# runtime environment.  An env file can override ENV, but it cannot rewrite an
# OCI label on an already-built image.
LABEL org.opencontainers.image.revision=$GIT_COMMIT_SHA

# 2026-08-15 SELF-HEALING. Without a HEALTHCHECK, Docker's only restart trigger
# is process exit — so a process that is up but wedged (every table frozen) was
# invisible to the supervisor forever. `liveness` goes 'dead' when any table
# with 2+ dealable seats has made no progress for 2 minutes, or when the
# discovery loop has stalled. Three consecutive failures => Docker restarts the
# container under --restart always. A frozen platform now recovers itself in
# about a minute with no human involved.
#
# 2026-08-23: PROBE 0.0.0.0, NOT 127.0.0.1. `httpServer.listen(PORT)` passes no
# host, so Node binds the unspecified address and answers on :: in a dual-stack
# container -- the IPv4 loopback probe was refused every single time. Docker
# marked the container unhealthy, sp-autoheal (which watches the autoheal=true
# label) killed it, --restart always brought it back, and it churned on a ~5
# minute cycle. A healthy engine executed by its own self-healing, voiding every
# in-flight hand on every restart.
# A busy single-threaded event loop has delayed even this lightweight endpoint
# beyond five seconds while the engine was still progressing. Because autoheal
# acts on this verdict by restarting every live table, keep a 15-second probe
# budget and a five-minute cold-start grace. Docker ends its built-in start
# period after the first successful probe, so the command also reads PID 1's
# Linux start time and returns healthy for the full first 300 seconds. That
# prevents an early success followed by load-ramp timeouts from defeating the
# grace. Once grace clears, three failures still identify a sustained wedge in
# roughly one minute. Linux exposes /proc stat start time in USER_HZ (100 Hz).
HEALTHCHECK --interval=20s --timeout=15s --start-period=300s --retries=3 \
  CMD node -e "const fs=require('fs');const s=fs.readFileSync('/proc/1/stat','utf8');const f=s.slice(s.lastIndexOf(')')+2).trim().split(' ').filter(Boolean);const u=Number(fs.readFileSync('/proc/uptime','utf8').split(' ')[0]);const a=u-Number(f[19])/100;if(a<300)process.exit(0);fetch('http://0.0.0.0:8080/health').then(r=>r.json()).then(j=>{const l=j.liveness;process.exit(j.running===true&&(l==='ok'||l==='standby')?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
