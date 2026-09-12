import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { lstat, chmod } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const CONTROL_ROOT = '/opt/qualification/controls/operations/release/native/';

// The second argument exists only for native tests using a temporary socket and
// the real reviewed helper modules. No wire/environment input selects helpers.
export async function startObservationBridge(options, testHarness = {}) {
  let notified = false;
  const notify = (category) => {
    if (!notified) {
      notified = true;
      options.onFailure?.(category);
    }
  };
  const startupError = () => notify('OBSERVATION_DATABASE_FAILED');
  options.db.on?.('error', startupError);
  try {
    const bridge = await startBridge({ ...options, onFailure: notify }, testHarness);
    if (notified) {
      await bridge.close();
      throw new Error('OBSERVATION_STARTUP_REFUSED');
    }
    return bridge;
  } catch {
    notify('OBSERVATION_STARTUP_REFUSED');
    await options.db.end().catch(() => {});
    throw new Error('OBSERVATION_BRIDGE_REFUSED');
  } finally {
    options.db.removeListener?.('error', startupError);
  }
}

async function startBridge({ db, binding, onFailure, financialActors }, testHarness = {}) {
  const protocol =
    testHarness.protocol ?? (await import(CONTROL_ROOT + 'component-observation-protocol.mjs'));
  const observations =
    testHarness.observations ??
    (await import(CONTROL_ROOT + 'component-semantic-observations.mjs'));
  const {
    validateBinding,
    validateRequest,
    validateData,
    REQUEST_BYTES,
    REPLY_BYTES,
    PERSISTENCE_MS,
    READ_MS,
    FINANCIAL_MS,
  } = protocol;
  const owned = validateBinding(binding);
  const actorIds = financialActors === undefined ? null : Object.freeze([...financialActors]);
  if (actorIds) {
    assert.equal(actorIds.length, 2);
    assert.equal(new Set([...actorIds, owned.spectator_user_id]).size, 3);
    for (const id of actorIds)
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  const socketPath = testHarness.socketPath ?? protocol.OBSERVATION_SOCKET;
  const fixtureUid = testHarness.fixtureUid ?? 1000;
  const observerGid = testHarness.observerGid ?? 1001;
  const now = testHarness.now ?? (() => performance.now());
  assert.equal(process.getuid(), fixtureUid);
  const parent = await lstat(path.dirname(socketPath));
  assert.ok(
    parent.isDirectory() &&
      !parent.isSymbolicLink() &&
      parent.uid === fixtureUid &&
      parent.gid === observerGid &&
      (parent.mode & 0o7777) === 0o2750,
    'OBSERVER_DIRECTORY_REFUSED'
  );
  try {
    await lstat(socketPath);
    throw new Error('OBSERVER_SOCKET_EXISTS');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  assert.equal(typeof onFailure, 'function');
  const sockets = new Set(),
    requestIds = new Set();
  let failed = false,
    closing = false,
    ready = false,
    busy = false,
    hand = null,
    handDeadline = null,
    closePromise;
  let server,
    handFloor,
    financial = null,
    financialDeadline = null;
  const abort = new AbortController();
  function fail(category) {
    if (failed || closing) return;
    failed = true;
    // Public failure is a constant category, never SQL, JWTs or child errors.
    try {
      onFailure(category);
    } catch {
      /* teardown must still finish */
    }
    void close();
  }
  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    ready = false;
    abort.abort();
    closePromise = (async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([
        new Promise((resolve) => {
          if (server?.listening) server.close(resolve);
          else resolve();
        }),
        db.end(),
      ]);
    })();
    return closePromise;
  }
  db.on?.('error', () => fail('OBSERVATION_DATABASE_FAILED'));
  async function execute(request) {
    const financialRead = request.read === 'financial_facts';
    if (financialRead) {
      assert.ok(actorIds, 'OBSERVATION_FINANCIAL_ACTORS_NOT_BOUND');
      if (!financial) {
        assert.ok(request.financial.hand_number > handFloor, 'OBSERVATION_HISTORICAL_HAND_REFUSED');
        financial = Object.freeze({ ...request.financial });
        financialDeadline = now() + FINANCIAL_MS;
      }
      assert.deepEqual(request.financial, financial, 'OBSERVATION_FINANCIAL_SUBSTITUTION');
      assert.ok(now() < financialDeadline, 'OBSERVATION_FINANCIAL_DEADLINE');
    } else if (request.read !== 'catalogue') {
      if (!hand) {
        assert.ok(request.hand.hand_number > handFloor, 'OBSERVATION_HISTORICAL_HAND_REFUSED');
        hand = Object.freeze({ ...request.hand });
        handDeadline = now() + PERSISTENCE_MS;
      }
      assert.deepEqual(request.hand, hand, 'OBSERVATION_HAND_SUBSTITUTION');
      assert.ok(now() < handDeadline, 'OBSERVATION_PERSISTENCE_DEADLINE');
    }
    const deadline = financialRead ? financialDeadline : handDeadline;
    const budget = request.read === 'catalogue' ? READ_MS : Math.min(READ_MS, deadline - now());
    assert.ok(budget > 0);
    let timer, abortListener;
    const work = async () => {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        await db.query(
          "SET LOCAL search_path = pg_catalog; SET LOCAL row_security = off; SET LOCAL lock_timeout = '1s'"
        );
        await db.query("SELECT pg_catalog.set_config('statement_timeout',$1,true)", [
          String(Math.max(1, Math.floor(Math.min(5000, budget)))),
        ]);
        let data;
        if (request.read === 'catalogue')
          data = { catalogue_digest: await observations.schemaCatalogue(db) };
        else if (financialRead)
          data = await observations.observeFinancialFacts(db, owned.table_id, actorIds, financial);
        else if (request.read === 'hand_presence')
          data = await observations.observeHandPresence(db, owned.table_id, hand.hand_number);
        else
          data = await observations.observeHandFacts(
            db,
            owned.table_id,
            hand.hand_number,
            owned.spectator_user_id
          );
        validateData(request.read, data);
        if (request.read !== 'catalogue')
          assert.ok(now() < deadline, 'OBSERVATION_PERSISTENCE_DEADLINE');
        await db.query('COMMIT');
        if (request.read !== 'catalogue')
          assert.ok(now() < deadline, 'OBSERVATION_PERSISTENCE_DEADLINE');
        return data;
      } catch (error) {
        await db.query('ROLLBACK').catch(() => {});
        throw error;
      }
    };
    try {
      return await Promise.race([
        work(),
        new Promise((_, reject) => {
          abortListener = () => reject(new Error('OBSERVATION_CLOSED'));
          abort.signal.addEventListener('abort', abortListener, { once: true });
          if (abort.signal.aborted) abortListener();
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            fail('OBSERVATION_READ_DEADLINE');
            reject(new Error('OBSERVATION_READ_DEADLINE'));
          }, budget);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener('abort', abortListener);
    }
  }
  server = net.createServer({ allowHalfOpen: true }, (socket) => {
    if (!ready || closing || sockets.size >= 4) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {
      if (!closing) fail('OBSERVATION_SOCKET_FAILED');
    });
    let bytes = 0,
      chunks = [],
      submitted = false;
    const frameTimer = setTimeout(() => fail('OBSERVATION_FRAME_DEADLINE'), 1000);
    socket.once('close', () => clearTimeout(frameTimer));
    socket.on('end', () => {
      if (!submitted && !closing) fail('OBSERVATION_FRAME_INCOMPLETE');
    });
    socket.on('data', (chunk) => {
      if (submitted) {
        fail('OBSERVATION_EXTRA_FRAME');
        return;
      }
      bytes += chunk.length;
      if (bytes > REQUEST_BYTES) {
        fail('OBSERVATION_REQUEST_TOO_LARGE');
        return;
      }
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks),
        newline = buffer.indexOf(10);
      if (newline < 0) return;
      if (newline !== buffer.length - 1) {
        fail('OBSERVATION_EXTRA_FRAME');
        return;
      }
      submitted = true;
      clearTimeout(frameTimer);
      chunks = [];
      let request;
      try {
        request = validateRequest(JSON.parse(buffer.subarray(0, -1).toString('utf8')), owned);
        assert.ok(!requestIds.has(request.request_id) && requestIds.size < 256);
        assert.equal(busy, false);
        requestIds.add(request.request_id);
        busy = true;
      } catch {
        fail('OBSERVATION_PROTOCOL_REFUSED');
        return;
      }
      void execute(request)
        .then((data) => {
          if (failed || closing) return;
          const response = {
            version: 1,
            request_id: request.request_id,
            binding: owned,
            read: request.read,
            ...(request.read === 'catalogue'
              ? {}
              : request.read === 'financial_facts'
                ? { financial }
                : { hand }),
            data,
          };
          const encoded = Buffer.from(JSON.stringify(response) + '\n');
          assert.ok(encoded.length <= REPLY_BYTES);
          socket.end(encoded);
        })
        .catch(() => fail('OBSERVATION_READ_FAILED'))
        .finally(() => {
          busy = false;
        });
    });
  });
  server.on('error', () => fail('OBSERVATION_SERVER_FAILED'));
  server.on('close', () => {
    if (!closing) fail('OBSERVATION_SERVER_CLOSED');
  });
  try {
    let startupTimer;
    try {
      await Promise.race([
        (async () => {
          await db.query(
            "SET default_transaction_read_only=on; SET statement_timeout='5s'; SET search_path=pg_catalog"
          );
          await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          try {
            await db.query("SET LOCAL row_security=off; SET LOCAL lock_timeout='1s'");
            handFloor = await observations.captureObservationHandFloor(db, owned.table_id);
            assert.ok(Number.isSafeInteger(handFloor) && handFloor >= 0);
            await db.query('COMMIT');
          } catch (error) {
            await db.query('ROLLBACK').catch(() => {});
            throw error;
          }
        })(),
        new Promise((_, reject) => {
          startupTimer = setTimeout(
            () => reject(new Error('OBSERVATION_STARTUP_DEADLINE')),
            READ_MS
          );
        }),
      ]);
    } finally {
      clearTimeout(startupTimer);
    }
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: socketPath, backlog: 1 }, resolve);
    });
    // Only the socket is chmodded. Its gid must come from the fresh setgid tmpfs.
    const inherited = await lstat(socketPath);
    assert.ok(
      inherited.isSocket() &&
        !inherited.isSymbolicLink() &&
        inherited.uid === fixtureUid &&
        inherited.gid === observerGid,
      'OBSERVER_SOCKET_OWNER_REFUSED'
    );
    await chmod(socketPath, 0o660);
    const socketStat = await lstat(socketPath),
      finalParent = await lstat(path.dirname(socketPath));
    assert.ok(
      socketStat.isSocket() &&
        socketStat.uid === fixtureUid &&
        socketStat.gid === observerGid &&
        (socketStat.mode & 0o7777) === 0o660
    );
    assert.ok(
      finalParent.ino === parent.ino &&
        finalParent.dev === parent.dev &&
        (finalParent.mode & 0o7777) === 0o2750 &&
        finalParent.uid === fixtureUid &&
        finalParent.gid === observerGid
    );
    ready = true;
    return { binding: owned, close };
  } catch (error) {
    fail('OBSERVATION_STARTUP_REFUSED');
    await close();
    throw new Error('OBSERVATION_STARTUP_REFUSED');
  }
}
