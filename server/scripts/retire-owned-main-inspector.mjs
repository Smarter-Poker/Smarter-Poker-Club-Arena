// Transport only. The owning locked transaction supplies fresh kernel/process
// qualification and owns its durable one-shot intent and listener readback.
// Importing this file performs no action.
export const OWNED_MAIN_INSPECTOR_CLOSE_EXPRESSION =
  "setImmediate(() => process.getBuiltinModule('node:inspector').close()); undefined";

export async function retireOwnedMainInspector({
  endpoint,
  expectedPid,
  deadlineMs,
  qualify,
  createWebSocket = (url) => new WebSocket(url),
}) {
  let socket,
    closeRequested = false,
    closeAcknowledged = false,
    connectionClosed = false,
    stage = 'invocation';
  const refusal = (reason) => new Error(reason);
  const result = (ok, reason) => ({
    ok,
    reason,
    stage,
    closeRequested,
    closeAcknowledged,
    connectionClosed,
    retryAllowed: false,
  });
  const bounded = async (promise) => {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) throw refusal('deadline_exhausted');
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          const expire = () => {
            const left = deadlineMs - Date.now();
            if (left > 0) timer = setTimeout(expire, left);
            else reject(refusal('deadline_exhausted'));
          };
          timer = setTimeout(expire, remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const url = new URL(endpoint);
    if (
      url.href !== endpoint ||
      url.protocol !== 'ws:' ||
      url.hostname !== '127.0.0.1' ||
      !/^[1-9][0-9]{0,4}$/.test(url.port) ||
      Number(url.port) > 65535 ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.pathname) ||
      !Number.isSafeInteger(expectedPid) ||
      expectedPid < 1 ||
      expectedPid === process.pid ||
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs <= Date.now() ||
      deadlineMs > Date.now() + 40000 ||
      typeof qualify !== 'function'
    )
      throw refusal('invocation_refused');
    const qualification = async (at) => {
      stage = at;
      if (Date.now() >= deadlineMs) throw refusal('deadline_exhausted');
      if (
        (await bounded(
          Promise.resolve().then(() =>
            qualify(at, {
              endpoint,
              expectedPid,
              deadlineMs,
              socket,
            })
          )
        )) !== true
      )
        throw refusal('qualification_refused');
      if (Date.now() >= deadlineMs) throw refusal('deadline_exhausted');
    };
    await qualification('attach');
    stage = 'connect';
    socket = createWebSocket(endpoint);
    let pending = null;
    const closed = new Promise((resolve) =>
      socket.addEventListener(
        'close',
        () => {
          connectionClosed = true;
          pending?.reject(refusal('connection_closed'));
          pending = null;
          resolve();
        },
        { once: true }
      )
    );
    socket.addEventListener('error', () => {
      pending?.reject(refusal('connection_error'));
      pending = null;
    });
    socket.addEventListener('message', ({ data }) => {
      try {
        if (typeof data !== 'string' || Buffer.byteLength(data) > 16384)
          throw refusal('protocol_refused');
        const message = JSON.parse(data);
        if (!pending || message.id !== pending.id) return;
        const waiter = pending;
        pending = null;
        if (message.error || message.result?.exceptionDetails)
          waiter.reject(refusal('evaluation_refused'));
        else waiter.resolve(message.result);
      } catch {
        pending?.reject(refusal('protocol_refused'));
        pending = null;
      }
    });
    await bounded(
      new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', () => reject(refusal('connection_error')), { once: true });
        socket.addEventListener('close', () => reject(refusal('connection_closed')), {
          once: true,
        });
      })
    );
    let id = 0;
    const evaluate = (expression) => {
      if (Date.now() >= deadlineMs) throw refusal('deadline_exhausted');
      return bounded(
        new Promise((resolve, reject) => {
          if (socket.readyState !== 1) return reject(refusal('connection_closed'));
          const requestId = ++id;
          pending = { id: requestId, resolve, reject };
          try {
            socket.send(
              JSON.stringify({
                id: requestId,
                method: 'Runtime.evaluate',
                params: { expression, returnByValue: true },
              })
            );
          } catch {
            pending = null;
            reject(refusal('send_outcome_unknown'));
          }
        })
      );
    };
    stage = 'pid';
    const identity = await evaluate('process.pid');
    if (identity?.result?.type !== 'number' || identity.result.value !== expectedPid)
      throw refusal('pid_mismatch');
    await qualification('close');
    stage = 'native_close';
    // From this point a lost ACK/close is unknown. Never send a competing
    // local close frame, reconnect, signal, or replay the native operation.
    closeRequested = true;
    const ack = await evaluate(OWNED_MAIN_INSPECTOR_CLOSE_EXPRESSION);
    if (ack?.result?.type !== 'undefined') throw refusal('close_ack_refused');
    closeAcknowledged = true;
    await bounded(closed);
    stage = 'complete';
    return result(true, 'native_close_observed');
  } catch (error) {
    // Only our client may close on a refusal BEFORE the native close request.
    if (!closeRequested && socket && socket.readyState < 2) socket.close();
    const reasons = new Set([
      'invocation_refused',
      'deadline_exhausted',
      'qualification_refused',
      'connection_closed',
      'connection_error',
      'protocol_refused',
      'evaluation_refused',
      'pid_mismatch',
      'send_outcome_unknown',
      'close_ack_refused',
    ]);
    return result(false, reasons.has(error?.message) ? error.message : 'outcome_unknown');
  }
}
