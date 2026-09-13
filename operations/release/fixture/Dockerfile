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
    && printf '%s\n' \
      'Acquire::Retries "3";' \
      'Acquire::https::Timeout "30";' \
      'Acquire::http::Timeout "30";' \
      > /etc/apt/apt.conf.d/80fixture-transport \
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
COPY fixture-server.mjs runtime-files.mjs gateway.mjs auth-fixture.mjs auth-bootstrap-proof.mjs service-role-boundary.mjs actors.mjs financial-route-phase.mjs seed-fixture.mjs native-smoke.mjs observation-bridge.mjs cron-provider.mjs safeupdate-provider.mjs service-preimage.mjs role-alignment.mjs provider-semantics.mjs provider-semantic-sql.mjs provider-probe-peer.mjs role-native-entry.mjs role-native-protocol.mjs role-native-faults.mjs role-native-access.mjs role-alignment-render.mjs role-alignment-installer.sql role-alignment-native.json role-alignment-aligned.json role-alignment-graph.sql role-alignment-membership.sql /opt/qualification/runtime/
RUN node --input-type=module -e "import {adaptRealtimeLauncher,adaptRealtimeConfiguration} from '/opt/qualification/runtime/fixture-server.mjs'; await adaptRealtimeLauncher(); await adaptRealtimeConfiguration();" \
    && node --input-type=module -e "import {writeFileSync} from 'node:fs'; import {providerKeyLauncher} from '/opt/qualification/runtime/provider-semantics.mjs'; writeFileSync('/usr/local/bin/fixture-provider-getkey',providerKeyLauncher,{flag:'wx',mode:0o555});" \
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

# Genuine single-version providers, no application SQL or service activation.
# This stage inherits the exact dated Debian snapshot and PostgreSQL17.11 ABI.
FROM supautils-builder AS genuine-providers-builder
USER root
RUN apt-get update -o APT::Update::Error-Mode=any \
    && apt-get install -y --no-install-recommends \
      libcurl4-openssl-dev libsodium-dev pkg-config perl file \
      libgeos-dev libproj-dev libgdal-dev libjson-c-dev libprotobuf-c-dev \
      protobuf-c-compiler libpcre2-dev libsfcgal-dev

ADD --checksum=sha256:b64ce29ac7e33790e9acef40a2fe3e9606b76743e468d9fae1c6125d5afb444f https://codeload.github.com/supabase/pg_net/tar.gz/a7792bfd913c7859e14025d606624982706c2a7f /tmp/pg-net.tar.gz
ADD --checksum=sha256:8745dfcf985801b23ca378caa038589aa7c1d7273109f28e41dc7567535c6fd2 https://codeload.github.com/pramsey/pgsql-http/tar.gz/5e2bd270a9ce2b0e8e1fdf8e46b85396bd4125cd /tmp/pgsql-http.tar.gz
ADD --checksum=sha256:bb7b43726aa08a2ca8e4205cd3961d373cb4287a4469fa06929f00939a1b1fc4 https://codeload.github.com/supabase/vault/tar.gz/6e0cd916242d922a646e4d611cc215e09dd429f4 /tmp/supabase-vault.tar.gz
ADD --checksum=sha256:ba1fedb89ad58eb1eb12dc57b02df6d06e3377fc3882562a0afe6a2f5d9c0ba3 https://codeload.github.com/okbob/plpgsql_check/tar.gz/7e23f9daa6b5408151aaec197c6cf6c948e23957 /tmp/plpgsql-check.tar.gz
ADD --checksum=sha256:50724a0dde49adc253e59e024d8b18fef6be4e85341943c6d5e1e1b974e43fce https://download.osgeo.org/postgis/source/postgis-3.3.7.tar.gz /tmp/postgis.tar.gz

RUN set -eu; \
    for source in pg-net pgsql-http supabase-vault plpgsql-check; do \
      mkdir "/tmp/$source"; \
      tar -xzf "/tmp/$source.tar.gz" --strip-components=1 -C "/tmp/$source"; \
      make -C "/tmp/$source" -j2 PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config; \
      make -C "/tmp/$source" PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config DESTDIR=/tmp/provider-install install; \
    done

# Match the official single-version Supabase packaging of the2.7 SQL contract
# from upstream2.7.11. Keep the genuine library/SQL; only the documented module
# filename changes. Native CREATE EXTENSION/catalog/C-function probes remain required.
RUN node --input-type=module -e ' \
      import fs from "node:fs"; \
      import assert from "node:assert/strict"; \
      const path="/tmp/provider-install/usr/share/postgresql/17/extension/plpgsql_check.control"; \
      const input=fs.readFileSync(path,"utf8"); \
      const before="module_pathname = " + String.fromCharCode(39) + "$libdir/plpgsql_check" + String.fromCharCode(39); \
      const after="module_pathname = " + String.fromCharCode(39) + "$libdir/plpgsql_check-2.7" + String.fromCharCode(39); \
      assert.equal(input.split(before).length-1,1); \
      fs.writeFileSync(path,input.replace(before,after)); \
      fs.renameSync("/tmp/provider-install/usr/lib/postgresql/17/lib/plpgsql_check.so", \
        "/tmp/provider-install/usr/lib/postgresql/17/lib/plpgsql_check-2.7.so"); \
      fs.symlinkSync("plpgsql_check-2.7.so", \
        "/tmp/provider-install/usr/lib/postgresql/17/lib/plpgsql_check.so");'

RUN mkdir /tmp/postgis \
    && tar -xzf /tmp/postgis.tar.gz --strip-components=1 -C /tmp/postgis \
    && cd /tmp/postgis \
    && ./configure --with-pgconfig=/usr/lib/postgresql/17/bin/pg_config \
      --with-gdalconfig=/usr/bin/gdal-config --with-jsondir=/usr --with-sfcgal \
    && make -j2 \
    && make DESTDIR=/tmp/provider-install install

RUN node --input-type=module -e ' \
      import fs from "node:fs"; \
      import path from "node:path"; \
      import assert from "node:assert/strict"; \
      import {createHash} from "node:crypto"; \
      const staging="/tmp/provider-install"; \
      assert.deepEqual(fs.readdirSync(staging).sort(),["usr"]); \
      const entries=[]; \
      function walk(relative){ \
        const full=path.join(staging,relative),s=fs.lstatSync(full); \
        assert.equal(s.mode & 0o6000,0,"set-id provider payload forbidden"); \
        const item={path:relative,mode:s.mode & 0o7777}; \
        if(s.isDirectory()){ \
          item.kind="directory";entries.push(item); \
          for(const name of fs.readdirSync(full).sort())walk(relative+"/"+name); \
        }else if(s.isSymbolicLink()){ \
          item.kind="symlink";item.target=fs.readlinkSync(full);entries.push(item); \
        }else{ \
          assert.ok(s.isFile(),"unsupported provider payload object"); \
          item.kind="file";item.size=s.size; \
          const fd=fs.openSync(full,"r"),buffer=Buffer.alloc(1024*1024),hash=createHash("sha256"); \
          let total=0,elf=false; \
          try{for(;;){const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break; \
            if(total===0)elf=n>=4&&buffer.subarray(0,4).equals(Buffer.from([127,69,76,70])); \
            hash.update(buffer.subarray(0,n));total+=n; \
          }}finally{fs.closeSync(fd);} \
          assert.equal(total,s.size);item.sha256=hash.digest("hex");item.elf=elf;entries.push(item); \
        } \
      } \
      walk("usr"); \
      assert.ok(entries.length>5&&entries.length<=20000); \
      fs.mkdirSync(staging+"/opt/qualification/provenance",{recursive:true}); \
      fs.writeFileSync(staging+"/opt/qualification/provenance/provider-payload.json", \
        JSON.stringify({version:1,payload_root:"/usr",entries})+"\n");'

RUN node --input-type=module -e ' \
      import fs from "node:fs"; \
      import assert from "node:assert/strict"; \
      import {createHash} from "node:crypto"; \
      import {execFileSync} from "node:child_process"; \
      const ext="/tmp/provider-install/usr/share/postgresql/17/extension/"; \
      const lib="/tmp/provider-install/usr/lib/postgresql/17/lib/"; \
      const versions={pg_net:"0.19.5",http:"1.6",supabase_vault:"0.3.1",plpgsql_check:"2.7",postgis:"3.3.7"}; \
      const libraries={pg_net:"pg_net.so",http:"http.so",supabase_vault:"supabase_vault.so",plpgsql_check:"plpgsql_check-2.7.so",postgis:"postgis-3.so"}; \
      const sources=[{"name":"postgis","catalog_version":"3.3.7","source_commit":null,"archive_url":"https://download.osgeo.org/postgis/source/postgis-3.3.7.tar.gz","archive_sha256":"50724a0dde49adc253e59e024d8b18fef6be4e85341943c6d5e1e1b974e43fce"},{"name":"pg_net","catalog_version":"0.19.5","source_commit":"a7792bfd913c7859e14025d606624982706c2a7f","archive_url":"https://codeload.github.com/supabase/pg_net/tar.gz/a7792bfd913c7859e14025d606624982706c2a7f","archive_sha256":"b64ce29ac7e33790e9acef40a2fe3e9606b76743e468d9fae1c6125d5afb444f"},{"name":"http","catalog_version":"1.6","source_commit":"5e2bd270a9ce2b0e8e1fdf8e46b85396bd4125cd","archive_url":"https://codeload.github.com/pramsey/pgsql-http/tar.gz/5e2bd270a9ce2b0e8e1fdf8e46b85396bd4125cd","archive_sha256":"8745dfcf985801b23ca378caa038589aa7c1d7273109f28e41dc7567535c6fd2"},{"name":"supabase_vault","catalog_version":"0.3.1","source_commit":"6e0cd916242d922a646e4d611cc215e09dd429f4","archive_url":"https://codeload.github.com/supabase/vault/tar.gz/6e0cd916242d922a646e4d611cc215e09dd429f4","archive_sha256":"bb7b43726aa08a2ca8e4205cd3961d373cb4287a4469fa06929f00939a1b1fc4"},{"name":"plpgsql_check","catalog_version":"2.7","source_version":"2.7.11","source_commit":"7e23f9daa6b5408151aaec197c6cf6c948e23957","archive_url":"https://codeload.github.com/okbob/plpgsql_check/tar.gz/7e23f9daa6b5408151aaec197c6cf6c948e23957","archive_sha256":"ba1fedb89ad58eb1eb12dc57b02df6d06e3377fc3882562a0afe6a2f5d9c0ba3"}]; \
      const toolchain=execFileSync("dpkg-query",["-W","-f=\u0024{binary:Package}=\u0024{Version}\n"],{encoding:"utf8"}).trim().split("\n").sort(); \
      const result={scope:"genuine-provider-build",sources,toolchain,postgres:execFileSync("/usr/lib/postgresql/17/bin/pg_config",["--version"],{encoding:"utf8"}).trim(),providers:{},native_qualified:false,production_binary_parity:false}; \
      function providerSqlFiles(name,version){ \
        const paths=name==="supabase_vault" ? ["supabase_vault--0.3.0.sql","supabase_vault--0.3.0--0.3.1.sql"] : [name+"--"+version+".sql"]; \
        const vaultPins={"supabase_vault--0.3.0.sql":"c3739f80d19e1fc18d114705a07ed9fc7c8e3750762abe51f8e9999716fdaff6","supabase_vault--0.3.0--0.3.1.sql":"c601f01c7d384054536fafd5ebd5d570542360bdcf2f14bfafd4876aaa5d174a"}; \
        if(name==="supabase_vault")assert.equal(version,"0.3.1"); \
        return paths.map(file=>{const bytes=fs.readFileSync(ext+file);assert.ok(bytes.length>0); \
          const sha256=createHash("sha256").update(bytes).digest("hex"); \
          if(name==="supabase_vault")assert.equal(sha256,vaultPins[file]); \
          return {file,sha256};}); \
      } \
      for(const [name,version] of Object.entries(versions)){ \
        const control=fs.readFileSync(ext+name+".control","utf8"); \
        const match=control.match(/^default_version\s*=\s*\x27([^\x27]+)\x27\s*$/m); \
        assert.equal(match?.[1],version); \
        const sql_install_path=providerSqlFiles(name,version); \
        const bytes=fs.readFileSync(lib+libraries[name]); \
        assert.ok(bytes.length>0); \
        result.providers[name]={version,library:libraries[name],control_sha256:createHash("sha256").update(control).digest("hex"),sql_install_path,library_sha256:createHash("sha256").update(bytes).digest("hex")}; \
      } \
      fs.mkdirSync("/tmp/provider-install/opt/qualification/provenance",{recursive:true}); \
      fs.writeFileSync("/tmp/provider-install/opt/qualification/provenance/genuine-providers.json",JSON.stringify(result)+"\n");'

FROM postgres-runtime
COPY --from=safeupdate-builder --chmod=0555 /tmp/safeupdate/safeupdate.so /usr/lib/postgresql/17/lib/safeupdate.so
COPY --from=cron-builder --chmod=0555 /tmp/cron-install/usr/lib/postgresql/17/lib/pg_cron.so /usr/lib/postgresql/17/lib/pg_cron.so
COPY --from=cron-builder /tmp/cron-install/usr/share/postgresql/17/extension/pg_cron* /usr/share/postgresql/17/extension/
COPY --from=supautils-builder --chmod=0555 /tmp/supautils/supautils.so /usr/lib/postgresql/17/lib/supautils.so
# Append to the final postgres-runtime stage after existing provider copies.
USER root
RUN apt-get update -o APT::Update::Error-Mode=any \
    && apt-get install -y --no-install-recommends \
      libcurl4t64 libsodium23 libgeos-c1t64 libproj25 libgdal36 libjson-c5 \
      libprotobuf-c1 libpcre2-8-0 libsfcgal2 libxml2 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=genuine-providers-builder /tmp/provider-install/opt/qualification/provenance/ /opt/qualification/provenance/
RUN node --input-type=module -e ' \
      import fs from "node:fs"; \
      import assert from "node:assert/strict"; \
      const manifest=JSON.parse(fs.readFileSync("/opt/qualification/provenance/provider-payload.json","utf8")); \
      assert.equal(manifest.version,1);assert.equal(manifest.payload_root,"/usr"); \
      for(const item of manifest.entries){ \
        if(item.kind==="directory")continue; \
        let existing=false;try{fs.lstatSync("/"+item.path);existing=true;}catch(error){if(error.code!=="ENOENT")throw error;} \
        assert.ok(!existing,"provider payload would replace an existing runtime file: "+item.path); \
      }'
COPY --from=genuine-providers-builder /tmp/provider-install/usr/ /usr/
RUN node --input-type=module -e ' \
      import fs from "node:fs"; \
      import path from "node:path"; \
      import assert from "node:assert/strict"; \
      import {createHash} from "node:crypto"; \
      import {execFileSync} from "node:child_process"; \
      const provenance="/opt/qualification/provenance/"; \
      const manifestBytes=fs.readFileSync(provenance+"provider-payload.json"); \
      assert.ok(manifestBytes.length<=16*1024*1024); \
      const manifest=JSON.parse(manifestBytes); \
      assert.equal(manifest.version,1);assert.equal(manifest.payload_root,"/usr"); \
      assert.ok(Array.isArray(manifest.entries)&&manifest.entries.length>5&&manifest.entries.length<=20000); \
      const inventory=new Map(),elfChecks=[],links=[]; \
      for(const item of manifest.entries){ \
        assert.ok(typeof item.path==="string"&&(item.path==="usr"||item.path.startsWith("usr/"))); \
        assert.equal(path.posix.normalize(item.path),item.path);assert.ok(!inventory.has(item.path)); \
        inventory.set(item.path,item); \
        const full="/"+item.path,s=fs.lstatSync(full); \
        assert.equal(s.mode & 0o7777,item.mode,"final mode drift: "+item.path); \
        if(item.kind==="directory"){assert.ok(s.isDirectory());continue;} \
        if(item.kind==="symlink"){ \
          assert.ok(s.isSymbolicLink());assert.equal(fs.readlinkSync(full),item.target); \
          links.push({path:item.path,resolved:fs.realpathSync(full)});continue; \
        } \
        assert.equal(item.kind,"file");assert.ok(s.isFile());assert.equal(s.size,item.size); \
        const fd=fs.openSync(full,"r"),buffer=Buffer.alloc(1024*1024),hash=createHash("sha256"); \
        let total=0,elf=false; \
        try{for(;;){const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break; \
          if(total===0)elf=n>=4&&buffer.subarray(0,4).equals(Buffer.from([127,69,76,70])); \
          hash.update(buffer.subarray(0,n));total+=n; \
        }}finally{fs.closeSync(fd);} \
        assert.equal(total,item.size);assert.equal(hash.digest("hex"),item.sha256); \
        assert.equal(elf,item.elf,"final ELF classification drift"); \
        if(elf){ \
          const output=execFileSync("ldd",[full],{encoding:"utf8",timeout:10000,maxBuffer:1024*1024}); \
          assert.ok(!output.includes("not found"),"unresolved provider dependency: "+item.path); \
          elfChecks.push({path:item.path,ldd:output.trim().split("\n")}); \
        } \
      } \
      for(const link of links){ \
        assert.ok(link.resolved.startsWith("/usr/"),"provider symlink escapes payload"); \
        const target=inventory.get(link.resolved.slice(1)); \
        assert.ok(target&&target.kind==="file","provider symlink target is not a shipped regular file"); \
        if(target.elf)assert.ok(elfChecks.some(item=>item.path===target.path)); \
      } \
      assert.ok(elfChecks.length>=5); \
      const runtimePackages=execFileSync("dpkg-query",["-W","-f=\u0024{binary:Package}=\u0024{Version}\n"], \
        {encoding:"utf8",timeout:10000,maxBuffer:4*1024*1024}).trim().split("\n").sort(); \
      fs.writeFileSync(provenance+"provider-final-runtime.json",JSON.stringify({ \
        version:1,scope:"complete-shipped-provider-payload",payload_manifest_sha256:createHash("sha256").update(manifestBytes).digest("hex"), \
        verified_entries:manifest.entries.length,elf_checks:elfChecks,symlink_targets:links, \
        runtime_packages:runtimePackages,native_extension_activation:false,production_binary_parity:false \
      })+"\n");'
USER fixture
