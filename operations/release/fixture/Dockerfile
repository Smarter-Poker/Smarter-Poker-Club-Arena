# Linux amd64 only. Each FROM pins the platform manifest, not a mutable tag.
# See README.md for primary-source provenance and the native qualification gap.
FROM node:22.23.2-bookworm-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96 AS node
FROM supabase/gotrue:v2.196.0@sha256:7e813221b93fbf54b515036438550e483bfaf057b9db52fe9bc1ce91c47e817e AS auth
FROM postgrest/postgrest:v14.5@sha256:bb289d00570b569525e1e22fb77c49cd17c17ca3f41da9ee2b4351a35027551b AS postgrest

FROM node AS dependencies
WORKDIR /opt/qualification
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force

# Keep the genuine Realtime Erlang release and its matching Debian libc together.
FROM supabase/realtime:v2.134.10@sha256:c1d078d929608f3eb4d441e30317bbdccc1bfcc1169efa3d1a26d4252417cc76
USER root
ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/usr/lib/postgresql/17/bin:/opt/qualification/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PLAYWRIGHT_BROWSERS_PATH=/opt/qualification/browsers \
    HOME=/tmp/fixture \
    TMPDIR=/tmp \
    XDG_CACHE_HOME=/tmp/fixture/cache \
    RELEASE_TMP=/tmp/fixture/realtime \
    ERL_CRASH_DUMP=/tmp/fixture/erl_crash.dump \
    ERL_AFLAGS="-proto_dist inet_tcp" \
    ECTO_IPV6=false

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=auth /usr/local/bin/auth /usr/local/bin/auth
COPY --from=postgrest /bin/postgrest /usr/local/bin/postgrest
COPY --from=dependencies /opt/qualification /opt/qualification

# A dated, signed Debian snapshot fixes transitive packages as well as PostgreSQL.
# Expiry is disabled only for this immutable historical snapshot; signatures stay on.
RUN test "$(dpkg --print-architecture)" = amd64 \
    && rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* \
    && printf '%s\n' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20260910T000000Z trixie main' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20260910T000000Z trixie-security main' \
      > /etc/apt/sources.list \
    && printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
    && chmod 0755 /usr/sbin/policy-rc.d \
    && mkdir -p /etc/postgresql-common \
    && printf 'create_main_cluster = false\n' > /etc/postgresql-common/createcluster.conf \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      postgresql-17=17.11-0+deb13u1 postgresql-client-17=17.11-0+deb13u1 \
      libpq5=17.11-0+deb13u1 postgresql-17-pgvector=0.8.0-1 \
      postgresql-17-wal2json=2.6-2+b1 \
      ca-certificates openssl unzip zip libatomic1 \
    && node /opt/qualification/node_modules/playwright/cli.js install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/.pgdelta-cache \
    && xz -dc /usr/local/share/pgdelta/pgdelta.xz > /app/.pgdelta-cache/pgdelta \
    && chmod 0555 /app/.pgdelta-cache/pgdelta \
    && groupadd --gid 1000 fixture \
    && useradd --uid 1000 --gid 1000 --no-create-home --home-dir /tmp/fixture --shell /usr/sbin/nologin fixture \
    && groupadd --gid 1001 qualification \
    && useradd --uid 1001 --gid 1001 --no-create-home --home-dir /tmp/qualification --shell /usr/sbin/nologin qualification \
    && chmod -R a+rX /opt/qualification /app \
    && test -f /app/releases/COOKIE \
    && chown root:fixture /app/releases/COOKIE \
    && chmod 0640 /app/releases/COOKIE \
    && test "$(node --version)" = v22.23.2 \
    && /usr/local/bin/auth version \
    && /usr/local/bin/postgrest --version \
    && /usr/lib/postgresql/17/bin/postgres --version \
    && /opt/qualification/node_modules/.bin/tsx --version \
    && test -r /usr/share/postgresql/17/extension/vector.control \
    && test -r /usr/lib/postgresql/17/lib/wal2json.so \
    && test -r /usr/share/postgresql/17/extension/dblink.control \
    && test -r /usr/share/postgresql/17/extension/pg_stat_statements.control \
    && test -r /usr/share/postgresql/17/extension/pg_trgm.control \
    && test -r /usr/share/postgresql/17/extension/pgcrypto.control \
    && test -r /usr/share/postgresql/17/extension/uuid-ossp.control

WORKDIR /opt/qualification
# These are trusted, reviewed runtime files, never supplied by a candidate archive.
COPY fixture-server.mjs runtime-files.mjs gateway.mjs auth-fixture.mjs actors.mjs seed-fixture.mjs native-smoke.mjs observation-bridge.mjs /opt/qualification/runtime/
RUN printf '#!/bin/sh\nexec /usr/local/bin/node /opt/qualification/runtime/fixture-server.mjs "$@"\n' > /usr/local/bin/fixture-server \
    && chmod 0555 /usr/local/bin/fixture-server \
    && chmod -R a+rX /opt/qualification/runtime
USER fixture
# The driver supplies "fixture-server capabilities|start|ready|engine-environment".
ENTRYPOINT ["/usr/bin/tini", "-s", "-g", "--"]
CMD ["fixture-server", "capabilities"]
