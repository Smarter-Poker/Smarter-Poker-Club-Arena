// Concatenated after the exact guard by the owning release transaction.
// Importing this module only exposes the isolated fixture seam.
import { setTimeout as checkpointDelay } from 'node:timers/promises';

class CheckpointTransportError extends Error {}
const refused = (code) => new CheckpointTransportError(code);
const remaining = (deadline, maximum) => {
  const left = Math.min(maximum, deadline - Date.now());
  if (left <= 0) throw refused('inspector operation outcome unknown');
  return left;
};

async function inspectorTarget(port, deadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      redirect: 'error',
      signal: AbortSignal.timeout(remaining(deadline, 500)),
    });
    if (!response.ok || !response.body) throw refused('inspector response refused');
    const reader = response.body.getReader(),
      parts = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (!part.value.byteLength || size > 16384) throw refused('inspector response refused');
        parts.push(Buffer.from(part.value));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const targets = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!Array.isArray(targets) || targets.length !== 1)
      throw refused('inspector target count refused');
    const url = new URL(targets[0].webSocketDebuggerUrl);
    if (
      url.protocol !== 'ws:' ||
      url.hostname !== '127.0.0.1' ||
      url.port !== String(port) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[0-9a-f-]{36}$/i.test(url.pathname)
    )
      throw refused('inspector endpoint refused');
    return url.href;
  } catch (error) {
    if (error?.cause?.code === 'ECONNREFUSED') return null;
    if (error instanceof CheckpointTransportError) throw error;
    throw refused('inspector discovery unavailable');
  }
}

function remoteValue(response) {
  if (response?.exceptionDetails || response?.result?.subtype === 'error')
    throw refused('target checkpoint evaluation refused');
  return response?.result;
}

function checkpointSummary(value) {
  const keys = [
    'schema',
    'ok',
    'reason',
    'stage',
    'attemptedTables',
    'completedCalls',
    'verifiedTables',
    'bankCount',
    'uninitializedSeats',
    'remainingMs',
    'readyForRestart',
    'checkpointOutcome',
    'paidAccountingQualification',
    'restartAuthorized',
  ];
  const result = {};
  for (const key of keys) {
    const item = value?.[key];
    const valid =
      key === 'schema'
        ? item === 'legacy-engine-checkpoint/v1'
        : key === 'reason'
          ? typeof item === 'string' &&
            item.length <= 128 &&
            /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(item)
          : key === 'stage'
            ? ['preflight', 'mixed_custody', 'checkpoint', 'readback', 'complete'].includes(item)
            : key === 'checkpointOutcome'
              ? ['not_started', 'unconfirmed', 'verified_at_observation'].includes(item)
              : key === 'paidAccountingQualification'
                ? [
                    'legacy_untracked',
                    'native_pending_registry_drained',
                    'native_pending_registry_unqualified',
                  ].includes(item)
                : key === 'restartAuthorized'
                  ? item === false
                  : ['ok', 'readyForRestart'].includes(key)
                    ? typeof item === 'boolean'
                    : key === 'remainingMs'
                      ? typeof item === 'number' && Number.isFinite(item) && item >= 0
                      : Number.isSafeInteger(item) && item >= 0;
    if (valid) result[key] = item;
  }
  // Observability only. The guard names which sub-condition refused in
  // these additional fields; they are carried verbatim when present and
  // simply absent otherwise. No decision reads them: `ok` and `reason`
  // above keep their exact prior meaning for every existing parser.
  for (const key of [
    'failedCheck',
    'failedTable',
    'failedField',
    'observed',
    'expected',
    'observedDetail',
    // Which tables were proved abandoned from rows, and how many unreachable
    // boundary generations each carried. Carried verbatim; nothing reads it.
    'abandonedBoundaries',
  ]) {
    const item = value?.[key];
    if (
      typeof item === 'string' &&
      item.length > 0 &&
      item.length <= 512 &&
      /^[\w .,:/=()+-]+$/.test(item)
    )
      result[key] = item;
  }
  return result;
}

function connectInspector(endpoint, deadline, createWebSocket) {
  const socket = createWebSocket(endpoint),
    pending = new Map();
  let nextId = 0,
    ended = false;
  const fail = (reason) => {
    ended = true;
    for (const waiter of pending.values()) waiter.reject(refused(reason));
    pending.clear();
  };
  socket.addEventListener('message', ({ data }) => {
    try {
      if (typeof data !== 'string' || Buffer.byteLength(data) > 65536)
        throw refused('inspector protocol refused');
      const message = JSON.parse(data),
        waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(refused('inspector protocol refused'));
      else waiter.resolve(message.result);
    } catch {
      fail('inspector protocol refused');
      socket.close();
    }
  });
  const closed = new Promise((resolve) =>
    socket.addEventListener('close', resolve, { once: true })
  );
  socket.addEventListener('close', () => fail('inspector disconnected; outcome unknown'));
  socket.addEventListener('error', () => fail('inspector disconnected; outcome unknown'));
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        socket.close();
        reject(refused('inspector connection timeout'));
      },
      remaining(deadline, 1000)
    );
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    const rejectOpen = () => {
      clearTimeout(timer);
      reject(refused('inspector connection refused'));
    };
    socket.addEventListener('error', rejectOpen, { once: true });
    socket.addEventListener('close', rejectOpen, { once: true });
  });
  return {
    socket,
    opened,
    closed,
    request(method, params, requestDeadline) {
      if (ended || socket.readyState !== WebSocket.OPEN)
        return Promise.reject(refused('inspector disconnected; outcome unknown'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => {
            pending.delete(id);
            reject(refused('inspector operation outcome unknown'));
          },
          remaining(requestDeadline, 20000)
        );
        pending.set(id, {
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch {
          const waiter = pending.get(id);
          pending.delete(id);
          waiter.reject(refused('inspector disconnected; outcome unknown'));
        }
      });
    },
    close() {
      fail('inspector disconnected; outcome unknown');
      socket.close();
    },
  };
}

/** One checkpoint attempt; a timeout/disconnect is unknown, never a retry.
 * The stdin production caller fixes PID, module coordinates and budgets. */
export async function runLegacyEngineCheckpoint({
  pid,
  instanceId,
  releaseSha,
  moduleExpression,
  guard,
  custodyIntent = null,
  port = 9229,
  workBudgetMs = 20000,
  cleanupBudgetMs = 5000,
  createWebSocket = (endpoint) => new WebSocket(endpoint),
}) {
  if (
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    pid === process.pid ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof instanceId !== 'string' ||
    !/^1-[0-9a-f]{8}$/.test(instanceId) ||
    !/^[0-9a-f]{40}$/.test(releaseSha ?? '') ||
    typeof moduleExpression !== 'string' ||
    moduleExpression.length > 16384 ||
    typeof guard !== 'function' ||
    !Number.isSafeInteger(workBudgetMs) ||
    workBudgetMs < 100 ||
    workBudgetMs > 20000 ||
    !Number.isSafeInteger(cleanupBudgetMs) ||
    cleanupBudgetMs < 100 ||
    cleanupBudgetMs > 5000
  )
    throw refused('legacy checkpoint invocation identity refused');
  const deadline = Date.now() + workBudgetMs;
  let signalled = false,
    endpoint,
    connection,
    result,
    failure;
  let checkpointInvoked = false,
    inspectorClosed = false,
    cleanupConnections = 0;
  const verifyPid = async (owned, until) => {
    const identity = remoteValue(
      await owned.request(
        'Runtime.evaluate',
        {
          expression: 'process.pid',
          returnByValue: true,
        },
        until
      )
    );
    if (identity?.value !== pid) throw refused('inspector process identity refused');
  };
  try {
    // Never attach to, signal or close an inspector predating this invocation.
    if (await inspectorTarget(port, deadline)) throw refused('inspector already active');
    process.kill(pid, 'SIGUSR1');
    signalled = true;
    for (let attempt = 0; attempt < 20 && !endpoint; attempt++) {
      await checkpointDelay(remaining(deadline, 50));
      endpoint = await inspectorTarget(port, deadline);
    }
    if (!endpoint) throw refused('inspector did not open');
    connection = connectInspector(endpoint, deadline, createWebSocket);
    await connection.opened;
    await verifyPid(connection, deadline);
    const modules = remoteValue(
      await connection.request(
        'Runtime.evaluate',
        {
          expression: moduleExpression,
          awaitPromise: true,
          objectGroup: 'legacy-checkpoint',
        },
        deadline
      )
    );
    if (!modules?.objectId) throw refused('cached modules unavailable');
    const prototype = remoteValue(
      await connection.request(
        'Runtime.callFunctionOn',
        {
          objectId: modules.objectId,
          functionDeclaration: 'function() { return this.gameServer.GameServer.prototype; }',
          objectGroup: 'legacy-checkpoint',
        },
        deadline
      )
    );
    if (!prototype?.objectId) throw refused('cached prototype unavailable');
    const objects = await connection.request(
      'Runtime.queryObjects',
      {
        prototypeObjectId: prototype.objectId,
        objectGroup: 'legacy-checkpoint',
      },
      deadline
    );
    const server = remoteValue(
      await connection.request(
        'Runtime.callFunctionOn',
        {
          objectId: objects.objects.objectId,
          functionDeclaration:
            'function() { if (this.length !== 1) throw new Error("singleton refused"); return this[0]; }',
          objectGroup: 'legacy-checkpoint',
        },
        deadline
      )
    );
    if (!server?.objectId) throw refused('singleton unavailable');
    checkpointInvoked = true;
    const response = remoteValue(
      await connection.request(
        'Runtime.callFunctionOn',
        {
          objectId: server.objectId,
          functionDeclaration: guard.toString(),
          arguments: [
            {
              value: {
                expectedReleaseSha: releaseSha,
                expectedInstanceId: instanceId,
                expectedPid: pid,
                custodyIntent,
              },
            },
            { objectId: objects.objects.objectId },
            { objectId: modules.objectId },
          ],
          awaitPromise: true,
          returnByValue: true,
        },
        deadline
      )
    );
    result = checkpointSummary(response?.value);
    if (result?.ok !== true) throw refused('native checkpoint did not qualify');
  } catch (error) {
    failure =
      error instanceof CheckpointTransportError
        ? error.message
        : 'inspector operation outcome unknown';
  } finally {
    if (signalled) {
      const cleanupDeadline = Date.now() + cleanupBudgetMs;
      let shutdownRequested = false;
      try {
        // One cleanup-only reconnection at most: no imports or guard calls.
        if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
          connection?.close();
          const current = await inspectorTarget(port, cleanupDeadline);
          if (current) {
            if (endpoint && current !== endpoint)
              throw refused('inspector cleanup identity changed');
            endpoint = current;
            cleanupConnections++;
            connection = connectInspector(current, cleanupDeadline, createWebSocket);
            await connection.opened;
          } else inspectorClosed = true;
        }
        if (!inspectorClosed) {
          await verifyPid(connection, cleanupDeadline);
          await connection.request(
            'Runtime.releaseObjectGroup',
            { objectGroup: 'legacy-checkpoint' },
            cleanupDeadline
          );
          // Native inspector shutdown owns the close handshake. A simultaneous
          // client close can crash the pinned Linux runtime; await its close.
          shutdownRequested = true;
          await connection.request(
            'Runtime.evaluate',
            {
              expression:
                "setImmediate(() => process.getBuiltinModule('node:inspector').close()); undefined",
              returnByValue: true,
            },
            cleanupDeadline
          );
        }
      } catch {
        failure = 'inspector cleanup outcome unknown';
      } finally {
        if (connection && shutdownRequested) {
          let closeTimer;
          try {
            await Promise.race([
              connection.closed,
              new Promise((_, reject) => {
                closeTimer = setTimeout(
                  () => reject(refused('inspector cleanup outcome unknown')),
                  remaining(cleanupDeadline, cleanupBudgetMs)
                );
              }),
            ]);
          } catch {
            // Do not introduce a competing close frame even on a deadline.
            // The stdin caller exits only its own helper after this bounded
            // cleanup attempt; the original operation remains nonretryable.
            failure = 'inspector cleanup outcome unknown';
          } finally {
            clearTimeout(closeTimer);
          }
        } else connection?.close();
      }
      while (!inspectorClosed && Date.now() < cleanupDeadline) {
        try {
          await checkpointDelay(remaining(cleanupDeadline, 50));
          inspectorClosed = (await inspectorTarget(port, cleanupDeadline)) === null;
        } catch {
          break;
        }
      }
      if (!inspectorClosed) failure = 'inspector cleanup not verified';
    } else connection?.close();
  }
  if (failure)
    return {
      ok: false,
      reason:
        failure === 'native checkpoint did not qualify' && result?.ok === false
          ? (result.reason ?? failure)
          : failure,
      // Preserve only the validated guard summary. Cleanup failure remains the
      // outer refusal and must not erase the original checkpoint observation.
      ...(result ? { checkpoint: result } : {}),
      retryAllowed: false,
      checkpointInvoked,
      inspectorClosed,
      cleanupConnections,
    };
  return { ...result, inspectorClosed, checkpointInvoked, cleanupConnections, retryAllowed: false };
}

if (process.argv[1] === '-' && new URL(import.meta.url).pathname.endsWith('/[eval1]')) {
  // Immutable production coordinates; no environment/argv source override.
  const checkpointRelease = process.argv[3];
  if (
    ![
      '2f4e33560bcd23bfb5cc731f31816b2c2e2847e5',
      '758610f3f844406bbbaee2f5100ced36d84fb943',
      'a0ab287d902879280f0c915e44f5222c5db4d7df',
      '8825af51817f379c4261658ca29ecc9d8d81932d',
    ].includes(checkpointRelease)
  )
    throw refused('checkpoint predecessor profile refused');
  const mixedImports =
    checkpointRelease === '8825af51817f379c4261658ca29ecc9d8d81932d'
      ? ", import('file:///app/dist/tournament/TournamentManager.js'), import('file:///app/dist/tournament/TournamentManagerBase.js'), import('file:///app/dist/services/F06HandPermit.js'), import('file:///app/dist/services/TournamentRetirementCustody.js')"
      : '';
  const checkpointModuleExpression = `process.getBuiltinModule('node:vm').runInThisContext(
    "Promise.all([import('file:///app/dist/GameServer.js'), import('file:///app/dist/engine/ServerTableEngineBase.js'), import('file:///app/dist/releaseIdentity.js'), import('file:///app/dist/services/tableLease.js'), import('file:///app/dist/services/supabase/client.js'), import('node:fs'), import('node:crypto'), import('file:///app/dist/maintenance/MaintenanceBreak.js'), import('file:///app/dist/maintenance/freezeState.js'), import('file:///app/dist/services/supabase/dataActorContext.js')${mixedImports}]).then(([gameServer,base,releaseIdentity,tableLease,client,fs,crypto,maintenance,freezeState,dataActorContext,manager,managerBase,permit,retirement])=>({gameServer,base,releaseIdentity,tableLease,client,fs,crypto,maintenance,freezeState,dataActorContext,manager,managerBase,permit,retirement}))",
    { importModuleDynamically: process.getBuiltinModule('node:vm').constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })`;
  const checkpointResult = await runLegacyEngineCheckpoint({
    pid: 1,
    port: 9229,
    instanceId: process.argv[2],
    releaseSha: checkpointRelease,
    moduleExpression: checkpointModuleExpression,
    guard: legacyEngineCheckpointGuard,
    custodyIntent: JSON.parse(process.argv[4] ?? 'null'),
  }).catch(() => ({
    ok: false,
    reason: 'legacy checkpoint invocation refused',
    retryAllowed: false,
  }));
  (checkpointResult.ok ? console.log : console.error)(JSON.stringify(checkpointResult));
  // A failed cleanup may retain a client socket. End this helper after its
  // bounded attempt without sending another WebSocket close to the engine.
  if (!checkpointResult.ok) process.exit(1);
}
