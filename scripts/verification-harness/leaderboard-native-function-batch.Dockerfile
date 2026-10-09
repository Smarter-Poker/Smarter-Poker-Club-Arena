# Qualification client only. Never a production database/engine image.
FROM node:22-bookworm AS node_runtime
FROM supabase/postgres:17.6.1.063
USER root
RUN apt-get update && apt-get install --no-install-recommends -y build-essential libssl-dev bison flex perl bzip2 pkg-config && rm -rf /var/lib/apt/lists/*
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
COPY postgresql-17.11.tar.bz2 /opt/native-build/source.tar.bz2
COPY pg_dump-batched.c /opt/native-build/pg_dump-batched.c
# Stock recursive prerequisites rebuild the same common/port archives.
# Serialize both builds so libpq is never linked against a partial archive.
RUN cd /opt/native-build && echo 'dd27f2b3c59e73ed14aa3324901242bf69a032a6347805f274e6260322d42979  source.tar.bz2' | sha256sum -c - && tar -xjf source.tar.bz2 && cd postgresql-17.11 && echo '8576b36741608e0a956b51e98e1b41b76877a95eb9091300b66c2eaa0faf78f8  src/bin/pg_dump/pg_dump.c' | sha256sum -c - && ./configure --prefix=/opt/lb-native --without-icu --without-readline --without-zlib --without-lz4 --without-zstd --with-ssl=openssl LDFLAGS='-Wl,-rpath,/opt/lb-native/lib' && make -C src/backend generated-headers && make -C src/bin/pg_dump -j1 && make -C src/interfaces/libpq install && mkdir -p /opt/lb-native/bin && cp src/bin/pg_dump/pg_dump /opt/lb-native/bin/pg_dump-stock && cp /opt/native-build/pg_dump-batched.c src/bin/pg_dump/pg_dump.c && make -C src/bin/pg_dump -j1 && cp src/bin/pg_dump/pg_dump /opt/lb-native/bin/pg_dump && rm -rf /opt/native-build
LABEL io.smarter.leaderboard.native-source="8576b36741608e0a956b51e98e1b41b76877a95eb9091300b66c2eaa0faf78f8"
