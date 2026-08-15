FROM node:22-slim

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install --production=false

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npx tsc

# Remove dev dependencies
RUN npm prune --production

# Run
ENV NODE_ENV=production
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

# 2026-08-15 SELF-HEALING. Without a HEALTHCHECK, Docker's only restart trigger
# is process exit — so a process that is up but wedged (every table frozen) was
# invisible to the supervisor forever. `liveness` goes 'dead' when any table
# with 2+ dealable seats has made no progress for 2 minutes, or when the
# discovery loop has stalled. Three consecutive failures => Docker restarts the
# container under --restart always. A frozen platform now recovers itself in
# about a minute with no human involved.
HEALTHCHECK --interval=20s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.json()).then(j=>process.exit(j.liveness==='dead'?1:0)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
