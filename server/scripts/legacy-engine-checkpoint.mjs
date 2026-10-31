export const LEGACY_CENSUS_NATIVE_SOURCE_SHA256 = 'cbd7279fc6595a31bd2044769d2ad85684d63713351acd0bb602dbfcdbdce31e';
// Concatenated after the exact guard by the owning release transaction.
// Importing this module only exposes the isolated fixture seam.
import { setTimeout as checkpointDelay } from 'node:timers/promises';

class CheckpointTransportError extends Error {}
const refused = (code) => new CheckpointTransportError(code);
/* ═══ AN UNKNOWN OUTCOME NAMES ITS OPERATION AND ITS DEADLINE (2026-09-25) ═══

   Run 36144233010 is the measurement: the deepest a release has reached, and
   the whole of what it reported was `inspector operation outcome unknown`.
   That one string is produced by three different facts, and they are not the
   same fact:

     - `budget_exhausted`: the publisher's work budget was ALREADY spent when
       this operation was about to be issued, so nothing was sent;
     - `request_timeout`: the operation WAS sent, ran past the slice of the
       budget that was left for it, and its answer is genuinely lost;
     - `unexpected_error`: something that is not a transport refusal escaped.

   Only the second one leaves a call in flight inside the predecessor, and
   only the second one can be answered by giving the operation more of the
   budget or by making it cheaper. Collapsed into one word, the run cannot
   say which fix it is asking for - and the number that decides it, how many
   milliseconds the operation actually got, was never written down at all.

   Observability only. `reason` is still exactly `inspector operation outcome
   unknown` for every existing parser, the refusal is still a refusal, and
   `retryAllowed` is still false: an operation whose answer was lost is not
   made knowable by describing it. What changes is that the description
   exists. The label rides on the error and is emitted as `transportDetail`,
   a compact `key=value` string held to the same 512-character carrier class
   the guard's own details use. */
const TRANSPORT_DETAIL = /^[\w .,:/=()+-]+$/;
const detailOf = (error) =>
  typeof error?.transportDetail === 'string' &&
  error.transportDetail.length > 0 &&
  error.transportDetail.length <= 512 &&
  TRANSPORT_DETAIL.test(error.transportDetail)
    ? error.transportDetail
    : null;
const lost = (detail) => {
  const error = refused('inspector operation outcome unknown');
  error.transportDetail = detail.slice(0, 512);
  return error;
};
const remaining = (deadline, maximum, operation = 'unnamed', observedAt = Date.now()) => {
  const left = Math.min(maximum, deadline - observedAt);
  if (left <= 0)
    throw lost(
      `op=${operation},cause=budget_exhausted,allowanceMs=0,overrunMs=${Date.now() - deadline}`
    );
  return left;
};

async function inspectorTarget(port, deadline, operation = 'inspectorDiscovery') {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      redirect: 'error',
      signal: AbortSignal.timeout(remaining(deadline, 500, operation)),
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

/** The guard's own progress record, read back from the predecessor's global
 *  object when the call's outcome is unknown (see the guard's `progress`).
 *  Observability only: a fixed set of keys, each held to its shape, or absent. */
function progressSummary(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    value.schema !== 'legacy-engine-checkpoint-progress/v1'
  )
    return null;
  const out = {};
  for (const key of ['elapsedMs', 'attemptedTables', 'completedCalls', 'verifiedTables']) {
    const item = value[key];
    if (Number.isSafeInteger(item) && item >= 0) out[key] = item;
  }
  for (const key of ['stage', 'note', 'reason']) {
    const item = value[key];
    if (typeof item === 'string' && item.length <= 64 && /^[A-Za-z][A-Za-z0-9_]*$/.test(item))
      out[key] = item;
  }
  // The step's own `key=value` pairs: which page, which manager, which RPC.
  // Same carrier class and ceiling as every other detail the guard emits.
  const detail = value.detail;
  if (
    typeof detail === 'string' &&
    detail.length > 0 &&
    detail.length <= 512 &&
    TRANSPORT_DETAIL.test(detail)
  )
    out.detail = detail;
  return Object.keys(out).length > 0 ? out : null;
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
    // How many retained managers the rows proved an earlier run had already
    // sealed, so this run transferred nothing for them (2026-09-25). A count,
    // validated like every other count; absent from a guard that predates it.
    'sealedManagers',
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
    // `failedCheck` names the sub-expression that refused; WHICH map, set,
    // drain condition or captured revision moved underneath it travels in
    // `observedDetail` below. This list is FIXED and drops every unlisted key,
    // so one carrier is the design: a key of its own has to be remembered
    // here too, and on 2026-09-21 it was not - `mixed_owner_changed` reached
    // the runner naming a call and nothing else, which is the whole reason
    // nobody could act on it (CLAUDE.md 10.86 rule 2: an unreadable answer
    // must not be coerced into an empty one).
    'observed',
    'expected',
    'observedDetail',
    // Which tables were proved abandoned from rows, and how many unreachable
    // boundary generations each carried. Carried verbatim; nothing reads it.
    'abandonedBoundaries',
    // How many residue players and disposed seats the rows proved held
    // nothing, and on which stopped tournaments. Carried verbatim; nothing
    // reads it.
    'bankDisposition',
    // Which tables held an F06 permit that no process could ever resolve, and
    // the phase each was in when the rows proved the felt quiet. This is the
    // record of what a release stepped over, so a refusal that never happened
    // is still legible afterwards. Carried verbatim; nothing reads it.
    'unresolvableCustody',
    // Which tables the capture walk refused and under which code, across the
    // whole fleet rather than the first table alone. One refused release costs
    // a maintenance break; this is what makes one break read the whole
    // blocking set. Carried verbatim; nothing reads it.
    'refusalCensus',
    // What was inside the rejections the previous-work join met, whether it
    // refused on them or stepped over them: the type and structured code of
    // each member, and their reduced sentences. It is what says whether a
    // failed join is a money write or a cleanup failure, and it is the
    // account of what a release stepped over. Carried verbatim; nothing
    // reads it.
    'nativeWorkMembers',
    // Which dead generations' park rows were proved from the row they had read
    // instead of written again (the database fences a write from a lease
    // generation that is no longer current), with what each row held. Carried
    // verbatim; nothing reads it.
    'provedRows',
    // What the seal lookup answered for each retained manager (2026-09-25):
    // sealed, none, other_generation, unanswered or malformed. Carried
    // verbatim; nothing reads it.
    'sealedLookup',
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
    // A ready-made error (one that already names its operation and cause)
    // is delivered as it is; a bare reason is wrapped exactly as before.
    for (const waiter of pending.values())
      waiter.reject(reason instanceof Error ? reason : refused(reason));
    pending.clear();
  };
  /* A PROTOCOL REFUSAL SAYS WHICH ONE (2026-10-30, run 41071578166). The
     owner-window release of 82f1e5632 reached the guard call on the serving
     EED predecessor and the whole outcome was the one word
     `inspector protocol refused`: three different events share it - an
     inspector response over the 64 KiB carrier, a CDP error object for the
     request in flight, and an unparseable frame - and nothing recorded which
     request it answered or what the inspector said. Observability only, as
     with `lost()` above: `reason` stays exactly `inspector protocol refused`,
     the refusal is still a refusal and `retryAllowed` is still false. What
     changes is that the operation, the cause and the inspector's own error
     code/message (sanitised to the same 512-character carrier class) ride on
     the error and reach `transportDetail`. */
  const protocolRefusal = (detail) => {
    const error = refused('inspector protocol refused');
    error.transportDetail = detail.replace(/[^\w .,:/=()+-]+/g, ' ').slice(0, 512);
    return error;
  };
  const describeCdpError = (value) => {
    const code = Number.isSafeInteger(value?.code) ? value.code : 'unknown';
    const text = typeof value?.message === 'string' ? value.message.slice(0, 160) : 'unknown';
    const data = typeof value?.data === 'string' ? value.data.slice(0, 160) : '';
    return `code=${code},message=${text}${data ? `,data=${data}` : ''}`;
  };
  socket.addEventListener('message', ({ data }) => {
    try {
      if (typeof data !== 'string' || Buffer.byteLength(data) > 65536) {
        const bytes = typeof data === 'string' ? Buffer.byteLength(data) : -1;
        let answered = 'unparsed';
        try {
          const id = JSON.parse(data)?.id;
          answered = pending.get(id)?.operation ?? `id ${String(id)}`;
        } catch {
          answered = 'unparsed';
        }
        throw protocolRefusal(`op=${answered},cause=oversize_response,bytes=${bytes}`);
      }
      const message = JSON.parse(data),
        waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error)
        waiter.reject(
          protocolRefusal(
            `op=${waiter.operation},cause=cdp_error,method=${waiter.method},${describeCdpError(message.error)}`
          )
        );
      else waiter.resolve(message.result);
    } catch (error) {
      fail(detailOf(error) ? error : 'inspector protocol refused');
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
      remaining(deadline, 1000, 'inspectorOpen')
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
    request(method, params, requestDeadline, operation = method) {
      if (ended || socket.readyState !== WebSocket.OPEN)
        return Promise.reject(refused('inspector disconnected; outcome unknown'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        // Computed inside the executor, exactly as before, so a budget that is
        // already spent still arrives as a rejection and never as a throw.
        const startedAt = Date.now();
        const allowanceMs = remaining(requestDeadline, 35000, operation, startedAt);
        const requestExpiresAt = startedAt + allowanceMs;
        let timer;
        const expireRequest = () => {
          // Timers are wakeups, not proof that their wall-clock deadline
          // elapsed. Keep the original absolute slice; never resend the call
          // or extend its work/cleanup budget after an early wakeup.
          const left = requestExpiresAt - Date.now();
          if (left > 0) {
            timer = setTimeout(expireRequest, left);
            return;
          }
          pending.delete(id);
          reject(
            lost(
              `op=${operation},cause=request_timeout,method=${method},` +
                `allowanceMs=${allowanceMs},waitedMs=${Date.now() - startedAt}`
            )
          );
        };
        timer = setTimeout(expireRequest, allowanceMs);
        pending.set(id, {
          operation,
          method,
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
/**
 * The refusals a release may stand down on, in two groups, both of which mean
 * "this attempt could not act", never "this attempt is unsafe".
 *
 * ARRIVED LATE. `insufficient_reserve` is the guard finding less than its
 * 285000ms reserve left. #5026 built `defer()` for exactly this sentence and
 * could only reach it ABOVE the intent write, so the guard's own copy of the
 * same finding stayed terminal - and it is what ended run 35625997626 at
 * 16:30 on 2026-09-21, twenty minutes after the ladder shipped. Deferring it
 * does NOT move the floor: the guard refuses at the identical threshold, on
 * the identical reading. It simply stops one mistimed arrival from consuming
 * the operation.
 *
 * OVERTAKEN WHILE READING. The four `*_changed` codes each mean a value the
 * guard had already READ stopped being what it read - the fleet gained or lost
 * a table, the server object was replaced, custody moved - between the capture
 * and the re-verification a page of Supabase reads later.
 *
 * Deliberately NOT here: every `maintenance_*` code, which is what stops a
 * cutover being certified over a hand in the air, and every code naming
 * durable state such as `bank_park_write_incomplete`. Those are safety
 * findings, not timing ones, and a refusal that is not in this list still ends
 * the release.
 */
export const CHECKPOINT_DEFERRABLE_REFUSALS = Object.freeze([
  'insufficient_reserve',
  'server_changed',
  'fleet_identity_changed',
  'mixed_owner_changed',
  'mixed_local_custody_changed',
]);

/**
 * True when the helper may exit 75 (defer) instead of 1 (die).
 *
 * WHY THIS EXISTS. `legacy-engine-checkpoint.sh` writes its O_EXCL intent
 * BEFORE opening the inspector, because a disconnect is unknown and unknown is
 * never permission to invoke again. That is right for a disconnect and wrong
 * for this: the guard came back, closed its inspector, and handed over a
 * complete receipt saying it refused in preflight having touched nothing. On
 * 2026-09-21 that exact receipt - stage `preflight`, `attemptedTables: 0`,
 * `completedCalls: 0`, `checkpointOutcome: "not_started"` - ended the release
 * permanently, twice, while 49 seats and 4,908,000 chips sat behind it.
 *
 * This is NOT a tolerance and NOT a retry loop (CLAUDE.md 10.12). The refusal
 * still refuses and nothing is retired; all that changes is that an attempt
 * which provably did not act stops poisoning every later attempt. Every
 * condition below is READ from the receipt, never inferred: if any field is
 * missing, unexpected, or says work began, this is false and the release dies
 * (CLAUDE.md 10.86 rules 1 and 2 - an unreadable answer is not an empty one).
 */
export function deferrableCheckpointRefusal(outcome) {
  const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isRecord(outcome) || outcome.ok !== false || outcome.retryAllowed !== false) return false;
  // A retained debugger session is an unknown process state, never a deferral.
  if (outcome.inspectorClosed !== true || outcome.cleanupConnections !== 0) return false;
  // A cleanup failure carries its OWN outer reason and must not be deferred
  // behind the guard's inner one; requiring the two to agree seals that.
  const checkpoint = isRecord(outcome.checkpoint) ? outcome.checkpoint : outcome;
  return (
    checkpoint.schema === 'legacy-engine-checkpoint/v1' &&
    checkpoint.ok === false &&
    checkpoint.stage === 'preflight' &&
    checkpoint.checkpointOutcome === 'not_started' &&
    checkpoint.attemptedTables === 0 &&
    checkpoint.completedCalls === 0 &&
    checkpoint.verifiedTables === 0 &&
    checkpoint.bankCount === 0 &&
    checkpoint.readyForRestart === false &&
    checkpoint.restartAuthorized === false &&
    typeof checkpoint.reason === 'string' &&
    checkpoint.reason === outcome.reason &&
    CHECKPOINT_DEFERRABLE_REFUSALS.includes(checkpoint.reason)
  );
}

// Serialized into the existing owned Inspector. The control wrapper binds the
// descriptor source hash to its protected LEGACY_CENSUS_NATIVE_SOURCE_SHA256 pin.
export function loadLegacyNativeCensus(descriptor) {
  const fail = () => { throw new Error('native census artifact identity refused'); };
  const fields = ['schema','path','manifestPath','binarySHA256','manifestSHA256','sourceSHA256',
    'candidateSHA','candidateImageId','candidateSourceTree'];
  if (!descriptor || typeof descriptor !== 'object' || descriptor.schema !== 'legacy-native-census-artifact/v1' ||
      Object.keys(descriptor).length !== fields.length ||
      !fields.every(k => typeof descriptor[k] === 'string') ||
      !/^\/app\/\.legacy-census-checkpoint-[1-9][0-9]*(?:-[1-9][0-9]*)?\/legacy-census\.node$/.test(descriptor.path) ||
      descriptor.manifestPath !== descriptor.path+'.json' ||
      !['binarySHA256','manifestSHA256','sourceSHA256'].every(k => /^[0-9a-f]{64}$/.test(descriptor[k])) ||
      !/^[0-9a-f]{40}$/.test(descriptor.candidateSHA) ||
      !/^sha256:[0-9a-f]{64}$/.test(descriptor.candidateImageId) ||
      !/^[0-9a-f]{40}$/.test(descriptor.candidateSourceTree)) fail();
  const fs = process.getBuiltinModule('node:fs');
  const crypto = process.getBuiltinModule('node:crypto');
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const read = path => {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.uid !== 0 || (before.mode & 0o022) !== 0 || before.size > 16*1024*1024) fail();
      const bytes = fs.readFileSync(fd);
      const after = fs.fstatSync(fd);
      if (['dev','ino','size','mtimeMs','ctimeMs'].some(k=>before[k]!==after[k])) fail();
      return bytes;
    } finally { fs.closeSync(fd); }
  };
  const raw = read(descriptor.manifestPath);
  if (sha(raw) !== descriptor.manifestSHA256) fail();
  const m = JSON.parse(raw);
  if (m.schema !== 'legacy-native-census-build/v1' || process.version !== 'v22.23.2' ||
      process.versions.v8 !== '12.4.254.21-node.56' || process.versions.modules !== '127' ||
      m.node !== process.version || m.v8 !== process.versions.v8 || m.modules !== process.versions.modules ||
      m.platform !== process.platform || m.arch !== process.arch ||
      m.pointerCompression !== process.config.variables.v8_enable_pointer_compression ||
      m.sourceSHA256 !== descriptor.sourceSHA256 || m.binarySHA256 !== descriptor.binarySHA256 ||
      m.maxMatches !== 22096 || m.managedOutputBytes !== 772608 ||
      sha(read(descriptor.path)) !== descriptor.binarySHA256) fail();
  const addon = process.getBuiltinModule('node:module').createRequire('/app/native/legacy-census-loader.cjs')(descriptor.path);
  if (typeof addon.collect !== 'function' || addon.sourceSHA256 !== descriptor.sourceSHA256 || addon.maxMatches !== 22096 || addon.managedOutputBytes !== 772608 ||
      sha(read(descriptor.path)) !== descriptor.binarySHA256) fail();
  return addon;
}

// Serialized into the existing owned inspector, with no ambient application inputs.
export function readLegacyCensusMemory() {
  const heap = process.getBuiltinModule('node:v8').getHeapStatistics();
  return {
    usedHeapBytes: heap.used_heap_size,
    availableHeapBytes: heap.total_available_size,
    availableProcessBytes:
      typeof process.availableMemory === 'function' ? process.availableMemory() : null,
  };
}

export function legacyCensusMemoryAdmission(value) {
  const fields = ['usedHeapBytes', 'availableHeapBytes', 'availableProcessBytes'];
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== fields.length ||
    !fields.every((key) => Number.isSafeInteger(value[key]) && value[key] > 0)
  )
    return null;
  const reserve = 32 * 1024 * 1024;
  // V8's native census retains local/global handles and a result vector before
  // constructing its JS array. Reserve well beyond the result array alone.
  // This is admission, never an increase to the predecessor's heap or memory.
  const requiredHeapBytes = value.usedHeapBytes + reserve;
  const requiredProcessBytes = value.usedHeapBytes * 8 + reserve;
  if (!Number.isSafeInteger(requiredProcessBytes)) return null;
  return {
    ...value,
    requiredHeapBytes,
    requiredProcessBytes,
    ok:
      value.availableHeapBytes >= requiredHeapBytes &&
      value.availableProcessBytes >= requiredProcessBytes,
  };
}

export function legacyCensusRoot() {
  const roots = [
    this.gameServer.GameServer.prototype,
    this.engine.ServerTableEngine.prototype,
    this.manager.TournamentManager.prototype,
    this.lightningWorker.LightningClusterWorker.prototype,
    this.lightningHost.LightningHandHost.prototype,
  ];
  const isProxy = process.getBuiltinModule('node:util').types.isProxy;
  // Every queried concrete class must reach this exact realm root, without
  // traversing a Proxy or overlapping another concrete class's chain.
  for (let i = 0; i < roots.length; i++) {
    let cursor = roots[i],
      depth = 0;
    while (cursor !== Object.prototype) {
      if (++depth > 256) throw new Error('native census root refused');
      if (
        cursor === null ||
        isProxy(cursor) ||
        roots.some((root, index) => index !== i && cursor === root)
      )
        throw new Error('native census root refused');
      cursor = Object.getPrototypeOf(cursor);
    }
  }
  return Object.prototype;
}

// Bind only cached modules before the synchronous census. No application
// prototype changes cross an Inspector request or an async boundary.
export function bindLegacyCensusModules(holderKey, workDeadlineMs, nativeCensus = null) {
  if (
    typeof holderKey !== 'string' ||
    !/^__legacyEngineCensus_[0-9a-f]{32}$/.test(holderKey) ||
    !Number.isSafeInteger(workDeadlineMs) ||
    workDeadlineMs <= Date.now() ||
    workDeadlineMs > Date.now() + 40000 ||
    Object.getOwnPropertyDescriptor(globalThis, holderKey)
  )
    throw new Error('native census binding refused');
  const holder = Object.create(null);
  Object.defineProperties(holder, {
    modules: { value: this },
    nativeCensus: { value: nativeCensus },
    deadline: { value: workDeadlineMs },
    schema: { value: 'legacy-marked-census/v1' },
  });
  Object.defineProperty(globalThis, holderKey, { value: holder, configurable: true });
  return true;
}

// Only an unentered, exact owned module binding may be retired separately.
// An active/unknown marked census must restore and remove its own holder.
export function retireLegacyCensusBinding(holderKey, workDeadlineMs) {
  if (typeof holderKey !== 'string' || !/^__legacyEngineCensus_[0-9a-f]{32}$/.test(holderKey))
    throw new Error('native census binding refused');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, holderKey);
  if (!descriptor) return true;
  const holder = descriptor.value;
  if (
    !holder ||
    process.getBuiltinModule('node:util').types.isProxy(holder) ||
    Object.getPrototypeOf(holder) !== null ||
    Object.getOwnPropertyDescriptor(holder, 'schema')?.value !== 'legacy-marked-census/v1' ||
    Object.getOwnPropertyDescriptor(holder, 'deadline')?.value !== workDeadlineMs ||
    Object.getOwnPropertyDescriptor(holder, 'marker')
  )
    throw new Error('native census binding is not unentered');
  if (!delete globalThis[holderKey]) throw new Error('native census binding cleanup refused');
  return true;
}

export function collectMarkedLegacyCensus(holderKey, workDeadlineMs) {
  const getPrototypeOf = Object.getPrototypeOf;
  const setPrototypeOf = Object.setPrototypeOf;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const defineProperty = Object.defineProperty;
  const isExtensible = Object.isExtensible;
  const root = Object.prototype;
  const isProxy = process.getBuiltinModule('node:util').types.isProxy;
  if (typeof holderKey !== 'string' || !/^__legacyEngineCensus_[0-9a-f]{32}$/.test(holderKey))
    throw new Error('native census binding refused');
  const holder = getOwnPropertyDescriptor(globalThis, holderKey)?.value;
  if (
    !holder ||
    isProxy(holder) ||
    getPrototypeOf(holder) !== null ||
    getOwnPropertyDescriptor(holder, 'schema')?.value !== 'legacy-marked-census/v1' ||
    getOwnPropertyDescriptor(holder, 'deadline')?.value !== workDeadlineMs ||
    !Number.isSafeInteger(workDeadlineMs)
  )
    throw new Error('native census binding refused');
  let session;
  try {
    if (workDeadlineMs <= Date.now() || workDeadlineMs > Date.now() + 40000)
      throw new Error('native census deadline exhausted');
    const modules = getOwnPropertyDescriptor(holder, 'modules')?.value;
    const roots = [
      modules.gameServer.GameServer.prototype,
      modules.engine.ServerTableEngine.prototype,
      modules.manager.TournamentManager.prototype,
      modules.lightningWorker.LightningClusterWorker.prototype,
      modules.lightningHost.LightningHandHost.prototype,
    ];
    const tops = [];
    for (let index = 0; index < roots.length; index++) {
      let cursor = roots[index];
      for (let depth = 0; ; depth++) {
        if (depth >= 256 || cursor === null || isProxy(cursor))
          throw new Error('native census root refused');
        for (let other = 0; other < roots.length; other++)
          if (other !== index && cursor === roots[other])
            throw new Error('native census root refused');
        const parent = getPrototypeOf(cursor);
        if (parent === root) {
          if (!isExtensible(cursor)) throw new Error('native census root not extensible');
          if (!tops.includes(cursor)) tops.push(cursor);
          break;
        }
        cursor = parent;
      }
    }
    const marker = Object.create(root);
    defineProperty(holder, 'marker', { value: marker });
    const { Session } = process.getBuiltinModule('node:inspector');
    session = new Session();
    session.connect();
    const post = (method, params) => {
      let called = false,
        result,
        error;
      session.post(method, params, (failure, response) => {
        called = true;
        error = failure;
        result = response;
      });
      if (!called) throw new Error('native census synchronous response refused');
      if (error || result?.exceptionDetails) throw new Error('native census protocol refused');
      return result;
    };
    const markerHandle = post('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(holderKey)}].marker`,
      disableBreaks: true,
      objectGroup: 'legacy-marked-native-census',
    });
    if (!markerHandle?.result?.objectId) throw new Error('native census marker unavailable');
    if (Date.now() >= workDeadlineMs) throw new Error('native census deadline exhausted');
    const changed = [];
    let census, nativeObjects;
    const native = getOwnPropertyDescriptor(holder, 'nativeCensus')?.value;
    try {
      for (const top of tops) {
        setPrototypeOf(top, marker);
        changed.push(top);
      }
      // The outer Runtime.evaluate has disableBreaks:true. The same native
      // dispatch owns insertion, this synchronous query and exact restoration;
      // queued remote cleanup and application callbacks cannot observe a marker.
      if (native) {
        nativeObjects = native.collect(marker, workDeadlineMs, process.availableMemory());
      } else {
        census = post('Runtime.queryObjects', {
          prototypeObjectId: markerHandle.result.objectId,
          objectGroup: 'legacy-marked-native-census',
        });
      }
    } finally {
      let failed = false;
      for (let index = changed.length - 1; index >= 0; index--) {
        try {
          setPrototypeOf(changed[index], root);
        } catch {
          failed = true;
        }
      }
      for (const top of tops) if (getPrototypeOf(top) !== root) failed = true;
      if (failed) throw new Error('native census prototype restoration refused');
    }
    if (Date.now() >= workDeadlineMs) throw new Error('native census deadline exhausted');
    if (native) {
      if (!Array.isArray(nativeObjects)) throw new Error('native census unavailable');
      defineProperty(holder, 'objects', { value: nativeObjects });
      return nativeObjects;
    }
    if (!census?.objects?.objectId) throw new Error('native census unavailable');
    post('Runtime.callFunctionOn', {
      objectId: census.objects.objectId,
      functionDeclaration: `function() { Object.defineProperty(globalThis[${JSON.stringify(holderKey)}], 'objects', { value: this }); return true; }`,
      returnByValue: true,
    });
    return getOwnPropertyDescriptor(holder, 'objects')?.value;
  } finally {
    try {
      session?.disconnect();
    } finally {
      if (getOwnPropertyDescriptor(globalThis, holderKey)?.value !== holder)
        throw new Error('native census binding ownership changed');
      if (!delete globalThis[holderKey]) throw new Error('native census binding cleanup refused');
    }
  }
}

export function projectLegacyCensus(modules, workDeadlineMs) {
  const startedAt = Date.now();
  if (
    !Number.isSafeInteger(workDeadlineMs) ||
    workDeadlineMs <= startedAt ||
    workDeadlineMs > startedAt + 40000
  )
    throw new Error('native census projection deadline refused');
  const roots = [
    modules.gameServer.GameServer.prototype,
    modules.engine.ServerTableEngine.prototype,
    modules.manager.TournamentManager.prototype,
    modules.lightningWorker.LightningClusterWorker.prototype,
    modules.lightningHost.LightningHandHost.prototype,
  ];
  const out = [[], [], [], [], []];
  const limits = [4000, 4000, 2000, 4000, 4000];
  const getPrototypeOf = Object.getPrototypeOf;
  const isProxy = process.getBuiltinModule('node:util').types.isProxy;
  const membership = new WeakMap([[Object.prototype, 0]]);
  roots.forEach((root, index) => membership.set(root, 1 << index));
  let cachedPrototypes = roots.length + 1;
  const classify = (prototype) => {
    if (prototype === null || isProxy(prototype)) return 0;
    const cached = membership.get(prototype);
    if (cached !== undefined) return cached;
    const path = [];
    let cursor = prototype,
      mask = 0;
    while (cursor !== null) {
      // Native queryObjects excludes Proxy chains too. Never execute a trap
      // while projecting unrelated objects from the broad native result.
      if (isProxy(cursor)) break;
      const known = membership.get(cursor);
      if (known !== undefined) {
        mask = known;
        break;
      }
      if (path.length >= 256) throw new Error('native census topology refused');
      path.push(cursor);
      cursor = getPrototypeOf(cursor);
    }
    for (const item of path) {
      if (cachedPrototypes >= 4096) throw new Error('native census topology refused');
      membership.set(item, mask);
      cachedPrototypes++;
    }
    return mask;
  };
  for (let index = 0; index < this.length; index++) {
    if ((index & 1023) === 0 && Date.now() >= workDeadlineMs)
      throw new Error('native census projection deadline exhausted');
    const value = this[index];
    if (isProxy(value)) continue;
    const mask = classify(getPrototypeOf(value));
    for (let group = 0; group < roots.length; group++)
      if (mask & (1 << group)) {
        if (out[group].length >= limits[group]) throw new Error('native census count refused');
        out[group].push(value);
      }
  }
  return out;
}

// Metadata already returned with each native projected array. These counts are
// diagnostic only: unknown descriptors never imply an empty physical owner.
function nativeCensusArrayCount(value, limit) {
  if (
    value?.type !== 'object' ||
    value.subtype !== 'array' ||
    value.className !== 'Array' ||
    typeof value.description !== 'string' ||
    value.description.length > 11
  )
    return null;
  const match = /^Array\((0|[1-9][0-9]{0,3})\)$/.exec(value.description);
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) && count <= limit ? count : null;
}

export async function runLegacyEngineCheckpoint({
  pid,
  instanceId,
  releaseSha,
  moduleExpression,
  guard,
  custodyIntent = null,
  discoverEngines = false,
  port = 9229,
  workBudgetMs = 20000,
  cleanupBudgetMs = 5000,
  checkpointDeadlineMs = null,
  createWebSocket = (endpoint) => new WebSocket(endpoint),
}) {
  const startedAt = Date.now();
  // The outer client is killed at the supplied absolute deadline. Reserve
  // one second INSIDE it to serialize/flush its bounded receipt and exit;
  // cleanup may still use at most its original five-second ceiling.
  const receiptReserveMs = checkpointDeadlineMs === null ? 0 : 1000;
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
    cleanupBudgetMs > 5000 ||
    (checkpointDeadlineMs !== null &&
      (!Number.isSafeInteger(checkpointDeadlineMs) ||
        checkpointDeadlineMs <= startedAt + cleanupBudgetMs + receiptReserveMs ||
        checkpointDeadlineMs > startedAt + 40000))
  )
    throw refused('legacy checkpoint invocation identity refused');
  // The production caller starts this one absolute budget before its entry
  // proof. Unused entry time belongs to the census, not to another window.
  // Cleanup keeps its own reserved slice inside the same forty seconds.
  const deadline =
    checkpointDeadlineMs === null
      ? startedAt + workBudgetMs
      : checkpointDeadlineMs - cleanupBudgetMs - receiptReserveMs;
  const effectiveWorkBudgetMs = deadline - startedAt;
  let signalled = false,
    endpoint,
    connection,
    result,
    failure;
  let censusBinding = null;
  let checkpointInvoked = false,
    inspectorClosed = false,
    cleanupConnections = 0,
    progress = null,
    transportDetail = null;
  // Which operation the transport is on. It is the name an unknown outcome
  // reports; it takes part in no decision and no branch reads it.
  let operation = 'inspectorEntry';
  let censusMemory = null,
    nativeCensusCounts = null;
  const describeLoss = (error) =>
    [
      detailOf(error) ??
        `op=${operation},cause=${
          error instanceof CheckpointTransportError ? 'transport_refused' : 'unexpected_error'
        }`,
      `budgetMs=${effectiveWorkBudgetMs}`,
      `spentMs=${Date.now() - startedAt}`,
      `invoked=${checkpointInvoked ? 'yes' : 'no'}`,
    ]
      .join(',')
      .slice(0, 512);
  const verifyPid = async (owned, until) => {
    const identity = remoteValue(
      await owned.request(
        'Runtime.evaluate',
        {
          expression: 'process.pid',
          returnByValue: true,
        },
        until,
        operation
      )
    );
    if (identity?.value !== pid) throw refused('inspector process identity refused');
  };
  try {
    // Never attach to, signal or close an inspector predating this invocation.
    operation = 'inspectorPreexisting';
    if (await inspectorTarget(port, deadline, operation)) throw refused('inspector already active');
    process.kill(pid, 'SIGUSR1');
    signalled = true;
    operation = 'inspectorOpen';
    for (let attempt = 0; attempt < 20 && !endpoint; attempt++) {
      await checkpointDelay(remaining(deadline, 50, 'inspectorOpenPoll'));
      endpoint = await inspectorTarget(port, deadline, operation);
    }
    if (!endpoint) throw refused('inspector did not open');
    connection = connectInspector(endpoint, deadline, createWebSocket);
    await connection.opened;
    operation = 'verifyProcessIdentity';
    await verifyPid(connection, deadline);
    operation = 'importModules';
    const modules = remoteValue(
      await connection.request(
        'Runtime.evaluate',
        {
          expression: moduleExpression,
          awaitPromise: true,
          objectGroup: 'legacy-checkpoint',
        },
        deadline,
        operation
      )
    );
    if (!modules?.objectId) throw refused('cached modules unavailable');
    let objects,
      server,
      engineObjects = null,
      managerObjects = null,
      lightningWorkerObjects = null,
      lightningHostObjects = null;
    if (discoverEngines) {
      let nativeArtifact = null;
      if (custodyIntent?.nativeCensus) {
        if (custodyIntent.nativeCensus.sourceSHA256 !== LEGACY_CENSUS_NATIVE_SOURCE_SHA256)
          throw refused('native census source identity refused');
        operation = 'loadNativeCensus';
        nativeArtifact = remoteValue(await connection.request('Runtime.evaluate', {
          expression: `(${loadLegacyNativeCensus.toString()})(${JSON.stringify(custodyIntent.nativeCensus)})`,
          objectGroup: 'legacy-checkpoint',
        }, deadline, operation));
        if (!nativeArtifact?.objectId) throw refused('native census artifact unavailable');
      }
      operation = 'censusMemoryAdmission';
      const memory = remoteValue(
        await connection.request(
          'Runtime.evaluate',
          {
            expression: `(${readLegacyCensusMemory.toString()})()`,
            returnByValue: true,
          },
          deadline,
          operation
        )
      );
      censusMemory = legacyCensusMemoryAdmission(memory?.value);
      if (nativeArtifact && censusMemory) {
        censusMemory.requiredHeapBytes = 32 * 1024 * 1024 + 772608;
        censusMemory.ok = censusMemory.availableHeapBytes >= censusMemory.requiredHeapBytes &&
          censusMemory.availableProcessBytes >= censusMemory.requiredProcessBytes;
        censusMemory.path = 'abi-pinned-bounded-native';
      }
      if (!censusMemory?.ok) throw refused('native census memory headroom refused');
      operation = 'broadPrototype';
      const prototype = remoteValue(
        await connection.request(
          'Runtime.callFunctionOn',
          {
            objectId: modules.objectId,
            functionDeclaration: legacyCensusRoot.toString(),
            objectGroup: 'legacy-broad-census',
          },
          deadline,
          operation
        )
      );
      if (!prototype?.objectId) throw refused('native census root unavailable');
      const holderKey = `__legacyEngineCensus_${process.getBuiltinModule('node:crypto').randomUUID().replaceAll('-', '')}`;
      censusBinding = { holderKey, deadline };
      operation = 'bindNativeCensusModules';
      const binding = remoteValue(
        await connection.request(
          'Runtime.callFunctionOn',
          {
            objectId: modules.objectId,
            functionDeclaration: bindLegacyCensusModules.toString(),
            arguments: [{ value: holderKey }, { value: deadline },
              ...(nativeArtifact ? [{ objectId: nativeArtifact.objectId }] : [])],
            returnByValue: true,
          },
          deadline,
          operation
        )
      );
      if (binding?.value !== true) throw refused('native census binding unavailable');
      operation = 'queryObjects';
      const broadValue = remoteValue(
        await connection.request(
          'Runtime.evaluate',
          {
            expression: `(${collectMarkedLegacyCensus.toString()})(${JSON.stringify(holderKey)}, ${deadline})`,
            disableBreaks: true,
            awaitPromise: false,
            objectGroup: 'legacy-broad-census',
          },
          deadline,
          operation
        )
      );
      const broad = { objects: broadValue };
      if (!broad.objects?.objectId) throw refused('native census unavailable');
      operation = 'projectNativePrototypes';
      const projected = remoteValue(
        await connection.request(
          'Runtime.callFunctionOn',
          {
            objectId: broad.objects.objectId,
            functionDeclaration: projectLegacyCensus.toString(),
            arguments: [{ objectId: modules.objectId }, { value: deadline }],
            objectGroup: 'legacy-checkpoint',
          },
          deadline,
          operation
        )
      );
      if (!projected?.objectId) throw refused('native census projection unavailable');
      const groups = [];
      const countFields = [
        ['gameServers', 4000],
        ['tableEngines', 4000],
        ['tournamentManagers', 2000],
        ['lightningWorkers', 4000],
        ['lightningHosts', 4000],
      ];
      for (let index = 0; index < 5; index++) {
        const group = remoteValue(
          await connection.request(
            'Runtime.callFunctionOn',
            {
              objectId: projected.objectId,
              functionDeclaration: `function() { return this[${index}]; }`,
              objectGroup: 'legacy-checkpoint',
            },
            deadline,
            'projectedCensusGroup'
          )
        );
        if (!group?.objectId) throw refused('native census group unavailable');
        nativeCensusCounts ??= {
          schema: 'legacy-native-census-counts/v1',
          gameServers: null,
          tableEngines: null,
          tournamentManagers: null,
          lightningWorkers: null,
          lightningHosts: null,
        };
        const [field, limit] = countFields[index];
        nativeCensusCounts[field] = nativeCensusArrayCount(group, limit);
        groups.push(group.objectId);
      }
      // The five small arrays retain their own independent handles. Do not
      // pin every unrelated heap object through the guard's private captures.
      operation = 'releaseBroadCensus';
      await connection.request(
        'Runtime.releaseObjectGroup',
        {
          objectGroup: 'legacy-broad-census',
        },
        deadline,
        operation
      );
      objects = { objects: { objectId: groups[0] } };
      [engineObjects, managerObjects, lightningWorkerObjects, lightningHostObjects] =
        groups.slice(1);
      operation = 'serverSingleton';
      server = remoteValue(
        await connection.request(
          'Runtime.callFunctionOn',
          {
            objectId: groups[0],
            objectGroup: 'legacy-checkpoint',
            functionDeclaration:
              'function() { if (this.length !== 1) throw new Error("singleton refused"); return this[0]; }',
          },
          deadline,
          operation
        )
      );
      if (!server?.objectId) throw refused('singleton unavailable');
    } else {
      operation = 'serverPrototype';
      const prototype = remoteValue(
        await connection.request(
          'Runtime.callFunctionOn',
          {
            objectId: modules.objectId,
            functionDeclaration: 'function() { return this.gameServer.GameServer.prototype; }',
            objectGroup: 'legacy-checkpoint',
          },
          deadline,
          operation
        )
      );
      if (!prototype?.objectId) throw refused('cached prototype unavailable');
      operation = 'queryObjects';
      objects = await connection.request(
        'Runtime.queryObjects',
        {
          prototypeObjectId: prototype.objectId,
          objectGroup: 'legacy-checkpoint',
        },
        deadline,
        operation
      );
      operation = 'serverSingleton';
      server = remoteValue(
        await connection.request(
          'Runtime.callFunctionOn',
          {
            objectId: objects.objects.objectId,
            functionDeclaration:
              'function() { if (this.length !== 1) throw new Error("singleton refused"); return this[0]; }',
            objectGroup: 'legacy-checkpoint',
          },
          deadline,
          operation
        )
      );
      if (!server?.objectId) throw refused('singleton unavailable');
    }
    checkpointInvoked = true;
    operation = 'guardCall';
    // Retain the returned Promise in the existing owned object group before
    // awaiting it. CDP's direct awaitPromise can lose an otherwise unrooted
    // pending Promise to GC and report "Promise was collected" after effects
    // have begun. Await this same invocation; never call the guard again.
    const pendingGuard = remoteValue(
      await connection.request(
        'Runtime.callFunctionOn',
        {
          objectId: server.objectId,
          // Observe rejection synchronously so Node cannot treat an immediate
          // guard rejection as unhandled between these two CDP requests. Keep
          // and return the ORIGINAL Promise: awaitPromise must still receive
          // its rejection, and no result or guard invocation is substituted.
          functionDeclaration: `function (...args) {
            const pendingCheckpoint = (${guard.toString()}).apply(this, args);
            pendingCheckpoint.catch(() => {});
            return pendingCheckpoint;
          }`,
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
            ...(discoverEngines
              ? [
                  { objectId: engineObjects },
                  { objectId: managerObjects },
                  { objectId: lightningWorkerObjects },
                  { objectId: lightningHostObjects },
                ]
              : []),
          ],
          awaitPromise: false,
          returnByValue: false,
          objectGroup: 'legacy-checkpoint',
        },
        deadline,
        operation
      )
    );
    if (
      pendingGuard?.type !== 'object' ||
      pendingGuard.subtype !== 'promise' ||
      !pendingGuard.objectId
    )
      throw refused('checkpoint promise unavailable');
    operation = 'guardAwait';
    const response = remoteValue(
      await connection.request(
        'Runtime.awaitPromise',
        { promiseObjectId: pendingGuard.objectId, returnByValue: true },
        deadline,
        operation
      )
    );
    result = checkpointSummary(response?.value);
    if (result?.ok !== true) throw refused('native checkpoint did not qualify');
  } catch (error) {
    failure =
      error instanceof CheckpointTransportError
        ? error.message
        : 'inspector operation outcome unknown';
    // Only an outcome nobody can state needs describing; a refusal that named
    // itself already has. The description never becomes the refusal. A
    // protocol refusal carries its own operation/cause/inspector error.
    if (/outcome unknown/.test(failure)) transportDetail = describeLoss(error);
    else if (failure === 'inspector protocol refused') transportDetail = detailOf(error);
  } finally {
    if (signalled) {
      const cleanupDeadline = Math.min(
        Date.now() + cleanupBudgetMs,
        checkpointDeadlineMs === null ? Infinity : checkpointDeadlineMs - receiptReserveMs
      );
      let shutdownRequested = false;
      try {
        // One cleanup-only reconnection at most: no imports or guard calls.
        if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
          connection?.close();
          operation = 'inspectorCleanupDiscovery';
          const current = await inspectorTarget(port, cleanupDeadline, operation);
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
          operation = 'inspectorCleanupPid';
          await verifyPid(connection, cleanupDeadline);
          // AN UNKNOWN OUTCOME SAYS HOW FAR IT GOT (2026-09-24, run 36041108119).
          // One read of the guard's own progress record, only when the call's
          // result never came back, on the cleanup connection this path
          // already holds. It changes no outcome: `failure` stays what it was.
          if (checkpointInvoked && !result && /outcome unknown/.test(failure ?? '')) {
            try {
              const read = remoteValue(
                await connection.request(
                  'Runtime.evaluate',
                  {
                    expression: 'globalThis.__legacyEngineCheckpointProgress ?? null',
                    returnByValue: true,
                  },
                  cleanupDeadline,
                  'inspectorCleanupProgress'
                )
              );
              progress = progressSummary(read?.value);
            } catch {
              // The record is a courtesy to the reader, never a condition.
            }
          }
          if (censusBinding) {
            const retired = remoteValue(
              await connection.request(
                'Runtime.evaluate',
                {
                  expression: `(${retireLegacyCensusBinding.toString()})(${JSON.stringify(censusBinding.holderKey)}, ${censusBinding.deadline})`,
                  disableBreaks: true,
                  returnByValue: true,
                },
                cleanupDeadline,
                'inspectorCleanupCensusBinding'
              )
            );
            if (retired?.value !== true) throw refused('native census binding cleanup refused');
          }
          if (discoverEngines)
            await connection.request(
              'Runtime.releaseObjectGroup',
              { objectGroup: 'legacy-broad-census' },
              cleanupDeadline,
              'inspectorCleanupBroadRelease'
            );
          operation = 'inspectorCleanupRelease';
          await connection.request(
            'Runtime.releaseObjectGroup',
            { objectGroup: 'legacy-checkpoint' },
            cleanupDeadline,
            operation
          );
          // Native inspector shutdown owns the close handshake. A simultaneous
          // client close can crash the pinned Linux runtime; await its close.
          shutdownRequested = true;
          operation = 'inspectorCleanupShutdown';
          await connection.request(
            'Runtime.evaluate',
            {
              expression:
                "setImmediate(() => process.getBuiltinModule('node:inspector').close()); undefined",
              returnByValue: true,
            },
            cleanupDeadline,
            operation
          );
        }
      } catch (error) {
        failure = 'inspector cleanup outcome unknown';
        // The work phase's own loss, when there was one, is the fact that
        // decides the next fix; a cleanup loss never overwrites it.
        transportDetail ??= describeLoss(error);
      } finally {
        if (connection && shutdownRequested) {
          let closeTimer;
          try {
            await Promise.race([
              connection.closed,
              new Promise((_, reject) => {
                closeTimer = setTimeout(
                  () => reject(refused('inspector cleanup outcome unknown')),
                  remaining(cleanupDeadline, cleanupBudgetMs, 'inspectorCleanupClose')
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
          await checkpointDelay(remaining(cleanupDeadline, 50, 'inspectorCleanupPoll'));
          inspectorClosed =
            (await inspectorTarget(port, cleanupDeadline, 'inspectorCleanupPoll')) === null;
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
      // Where the guard had got to when the outcome was lost, if it said.
      ...(progress ? { progress } : {}),
      // Which operation was lost, and how much of the budget it was given.
      ...(transportDetail ? { transportDetail } : {}),
      ...(censusMemory ? { censusMemory } : {}),
      ...(nativeCensusCounts ? { nativeCensusCounts } : {}),
      retryAllowed: false,
      checkpointInvoked,
      inspectorClosed,
      cleanupConnections,
    };
  return {
    ...result,
    ...(censusMemory ? { censusMemory } : {}),
    inspectorClosed,
    checkpointInvoked,
    cleanupConnections,
    retryAllowed: false,
  };
}

// Publish only the existing validated summary. Await the actual stream callback
// before the CLI exits, including under pipe backpressure, inside its reserved
// second and original absolute deadline. A lost receipt never authorizes retry.
export function publishLegacyCheckpointReceipt(result, deadlineMs) {
  // Keep 100ms of the reserved second for CLI exit and outer forwarding even
  // when publication itself times out. Never wait at the shell kill boundary.
  const expiresAt = Math.min(deadlineMs - 100, Date.now() + 900);
  if (!Number.isSafeInteger(deadlineMs) || expiresAt <= Date.now()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const stream = result.ok ? process.stdout : process.stderr;
    let timer,
      ended = false;
    const finish = (ok) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      // A failed write callback can precede its stream error event. Keep our
      // one-shot listener for that pending error until it fires or this CLI
      // exits; never let a late EPIPE print an uncaught native exception.
      if (ok) stream.removeListener('error', failed);
      resolve(ok);
    };
    const failed = () => finish(false);
    const expire = () => {
      const left = expiresAt - Date.now();
      if (left > 0) timer = setTimeout(expire, left);
      else finish(false);
    };
    stream.once('error', failed);
    timer = setTimeout(expire, Math.max(1, expiresAt - Date.now()));
    try {
      stream.write(JSON.stringify(result) + '\n', (error) =>
        finish(!error && Date.now() <= expiresAt)
      );
    } catch {
      finish(false);
    }
  });
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
      'eed06fe51dea622069c661a6213d5b031ff3a9e3',
    ].includes(checkpointRelease)
  )
    throw refused('checkpoint predecessor profile refused');
  const retainedEed = checkpointRelease === 'eed06fe51dea622069c661a6213d5b031ff3a9e3';
  const mixedImports =
    retainedEed || checkpointRelease === '8825af51817f379c4261658ca29ecc9d8d81932d'
      ? ", import('file:///app/dist/tournament/TournamentManager.js'), import('file:///app/dist/tournament/TournamentManagerBase.js'), import('file:///app/dist/services/F06HandPermit.js'), import('file:///app/dist/services/TournamentRetirementCustody.js')"
      : '';
  const retainedImports = retainedEed
    ? ", import('file:///app/dist/engine/ServerTableEngine.js'), import('file:///app/dist/engine/HandController.js'), import('file:///app/dist/engine/PrivateHandContinuation.js'), import('file:///app/dist/lightning/LightningRegistry.js'), import('file:///app/dist/lightning/LightningSupervisor.js'), import('file:///app/dist/lightning/LightningClusterWorker.js'), import('file:///app/dist/lightning/LightningFormationGate.js'), import('file:///app/dist/lightning/LightningHandHost.js')"
    : '';
  const checkpointModuleExpression = `process.getBuiltinModule('node:vm').runInThisContext(
    "Promise.all([import('file:///app/dist/GameServer.js'), import('file:///app/dist/engine/ServerTableEngineBase.js'), import('file:///app/dist/releaseIdentity.js'), import('file:///app/dist/services/tableLease.js'), import('file:///app/dist/services/supabase/client.js'), import('node:fs'), import('node:crypto'), import('file:///app/dist/maintenance/MaintenanceBreak.js'), import('file:///app/dist/maintenance/freezeState.js'), import('file:///app/dist/services/supabase/dataActorContext.js')${mixedImports}${retainedImports}]).then(([gameServer,base,releaseIdentity,tableLease,client,fs,crypto,maintenance,freezeState,dataActorContext,manager,managerBase,permit,retirement,engine,controller,privateContinuation,lightningRegistry,lightningSupervisor,lightningWorker,lightningFormation,lightningHost])=>({gameServer,base,releaseIdentity,tableLease,client,fs,crypto,maintenance,freezeState,dataActorContext,manager,managerBase,permit,retirement,engine,controller,privateContinuation,lightningRegistry,lightningSupervisor,lightningWorker,lightningFormation,lightningHost}))",
    { importModuleDynamically: process.getBuiltinModule('node:vm').constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })`;
  const checkpointResult = await runLegacyEngineCheckpoint({
    pid: 1,
    port: 9229,
    instanceId: process.argv[2],
    releaseSha: checkpointRelease,
    moduleExpression: checkpointModuleExpression,
    guard: retainedEed ? retainedOriginalCheckpointGuard : legacyEngineCheckpointGuard,
    discoverEngines: retainedEed,
    custodyIntent: JSON.parse(process.argv[4] ?? 'null'),
    checkpointDeadlineMs: Number(process.argv[5]),
  }).catch(() => ({
    ok: false,
    reason: 'legacy checkpoint invocation refused',
    retryAllowed: false,
  }));
  const receiptPublished = await publishLegacyCheckpointReceipt(
    checkpointResult,
    Number(process.argv[5])
  );
  if (!receiptPublished) process.exit(1);
  // A failed cleanup may retain a client socket. End this helper after its
  // bounded attempt without sending another WebSocket close to the engine.
  // 75 is `legacy-engine-checkpoint.sh`'s deferral, and it is reachable here
  // ONLY on a receipt that proves this attempt touched nothing. Anything else,
  // including an unreadable or partial receipt, is 1 and ends the release.
  if (!checkpointResult.ok) process.exit(deferrableCheckpointRefusal(checkpointResult) ? 75 : 1);
}
