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
FROM supabase/realtime:v2.134.10@sha256:c1d078d929608f3eb4d441e30317bbdccc1bfcc1169efa3d1a26d4252417cc76 AS postgres-runtime
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

# The minimal Realtime image has no system CA bundle. Bootstrap HTTPS from the
# pinned official Node binary's bundled Mozilla roots; APT then installs its
# signed ca-certificates package. TLS and repository signature checks stay on.
RUN node -e "const fs=require('node:fs'); const roots=require('node:tls').rootCertificates; if(roots.length<100) throw Error('Missing pinned TLS roots'); fs.mkdirSync('/etc/ssl/certs',{recursive:true}); fs.writeFileSync('/etc/ssl/certs/ca-certificates.crt',roots.join('\\n')+'\\n',{mode:0o644});"

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
    && apt-get update -o APT::Update::Error-Mode=any \
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
COPY fixture-server.mjs runtime-files.mjs gateway.mjs auth-fixture.mjs auth-bootstrap-proof.mjs service-role-boundary.mjs actors.mjs financial-route-phase.mjs seed-fixture.mjs native-smoke.mjs observation-bridge.mjs cron-provider.mjs safeupdate-provider.mjs service-preimage.mjs /opt/qualification/runtime/
RUN node --input-type=module -e "import {adaptRealtimeLauncher,adaptRealtimeConfiguration} from '/opt/qualification/runtime/fixture-server.mjs'; await adaptRealtimeLauncher(); await adaptRealtimeConfiguration();" \
    && printf '#!/bin/sh\nexec /usr/local/bin/node /opt/qualification/runtime/fixture-server.mjs "$@"\n' > /usr/local/bin/fixture-server \
    && chmod 0555 /usr/local/bin/fixture-server \
    && chmod -R a+rX /opt/qualification/runtime
USER fixture
# The driver supplies "fixture-server capabilities|start|ready|engine-environment".
ENTRYPOINT ["/usr/bin/tini", "-s", "-g", "--"]
CMD ["fixture-server", "capabilities"]

# Build the official managed-Postgres hook against the same pinned PG17 ABI.
# Compiler packages stay in this CI-only intermediate stage.
FROM postgres-runtime AS supautils-builder
USER root
ADD --checksum=sha256:36c758bd7facda65e1c8ce4a59ebf714d36f3054a2d898a1e8d53cae37e71bec https://codeload.github.com/supabase/supautils/tar.gz/e35f8affc4467202ff0d98f8dd14cb955bc13c75 /tmp/supautils.tar.gz
RUN apt-get update -o APT::Update::Error-Mode=any \
    && apt-get install -y --no-install-recommends build-essential patch libicu-dev libxml2-dev postgresql-server-dev-17=17.11-0+deb13u1 \
    && mkdir /tmp/supautils \
    && tar -xzf /tmp/supautils.tar.gz --strip-components=1 -C /tmp/supautils \
    && make -C /tmp/supautils PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config \
    && test -s /tmp/supautils/supautils.so

# Real pg_cron 1.6.4 with the official Supabase heap-table patch. Its upstream
# control version is 1.6; Supabase's schema-identical alignment migration names
# that same SQL schema 1.6.4. This single-version fixture retains that provenance.
FROM supautils-builder AS cron-builder
ADD --checksum=sha256:d89bcf7197f8b883ac1726ece0fbd72305e91dfa149f69d95e003a3eb6a7dcfd https://codeload.github.com/citusdata/pg_cron/tar.gz/9490f9cc9803f75105f2f7d89839a998f011f8d8 /tmp/pg-cron.tar.gz
ADD --checksum=sha256:47134f2c718dfb6bdad59da4fde12af4fb82db1f7725c02729aaf7521392bc0c https://raw.githubusercontent.com/supabase/postgres/18464f5d928cc2bfb2f9d5b018894d808f5c705f/nix/ext/pg_cron/pg_cron-heap-tables.patch /tmp/pg-cron-heap.patch
RUN mkdir /tmp/pg-cron \
    && tar -xzf /tmp/pg-cron.tar.gz --strip-components=1 -C /tmp/pg-cron \
    && cd /tmp/pg-cron \
    && patch --batch --fuzz=0 -p1 < /tmp/pg-cron-heap.patch \
    && make PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config \
    && make PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config DESTDIR=/tmp/cron-install install \
    && test -s /tmp/cron-install/usr/lib/postgresql/17/lib/pg_cron.so \
    && sed -i "s/^default_version = '1.6'$/default_version = '1.6.4'/" /tmp/cron-install/usr/share/postgresql/17/extension/pg_cron.control \
    && printf '%s\n' '-- Alignment migration: 1.6 and 1.6.4 are schema-identical.' > /tmp/cron-install/usr/share/postgresql/17/extension/pg_cron--1.6--1.6.4.sql

# PostgreSQL17 ABI build of the real safeupdate1.4 hook, never a SQL replacement.
FROM supautils-builder AS safeupdate-builder
ADD --checksum=sha256:fc9dc2699ab43fa2a19cae382d497caa95abb7029864af5adaa0c96d4d656c09 https://codeload.github.com/eradman/pg-safeupdate/tar.gz/104f78d27b607076b49f22927ba33828fd0a98a0 /tmp/safeupdate.tar.gz
RUN mkdir /tmp/safeupdate \
    && tar -xzf /tmp/safeupdate.tar.gz --strip-components=1 -C /tmp/safeupdate \
    && make -C /tmp/safeupdate PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config \
    && test -s /tmp/safeupdate/safeupdate.so

FROM postgres-runtime
COPY --from=safeupdate-builder --chmod=0555 /tmp/safeupdate/safeupdate.so /usr/lib/postgresql/17/lib/safeupdate.so
COPY --from=cron-builder --chmod=0555 /tmp/cron-install/usr/lib/postgresql/17/lib/pg_cron.so /usr/lib/postgresql/17/lib/pg_cron.so
COPY --from=cron-builder /tmp/cron-install/usr/share/postgresql/17/extension/pg_cron* /usr/share/postgresql/17/extension/
COPY --from=supautils-builder --chmod=0555 /tmp/supautils/supautils.so /usr/lib/postgresql/17/lib/supautils.so
