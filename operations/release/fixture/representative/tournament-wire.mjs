const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const bettingStages = new Set(['preflop', 'flop', 'turn', 'river']);
const stages = new Set(['waiting', ...bettingStages, 'showdown']);
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validMoney = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function protocol(ok, code) {
  if (!ok) throw new Error(`FIXTURE_ACTOR_${code}`);
}

function endpoints(testEndpoints) {
  if (testEndpoints === undefined) return { http: 'http://engine:8080', ws: 'ws://engine:8080' };
  protocol(
    record(testEndpoints) && Object.keys(testEndpoints).sort().join(',') === 'http,ws',
    'ENDPOINT'
  );
  const http = new URL(testEndpoints.http),
    ws = new URL(testEndpoints.ws);
  for (const endpoint of [http, ws]) {
    protocol(
      endpoint.hostname === '127.0.0.1' &&
        endpoint.port !== '' &&
        endpoint.pathname === '/' &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.search &&
        !endpoint.hash,
      'ENDPOINT'
    );
  }
  protocol(http.protocol === 'http:' && ws.protocol === 'ws:' && http.port === ws.port, 'ENDPOINT');
  return { http: http.origin, ws: ws.origin };
}

// The server's fast-json-patch compare emits add/remove/replace. Unknown RFC6902
// operations fail closed; paths cannot traverse prototype keys or invent parents.
export function patched(source, operations) {
  protocol(Array.isArray(operations) && operations.length <= 4096, 'PATCH');
  let result = structuredClone(source);
  for (const operation of operations) {
    protocol(
      record(operation) &&
        ['add', 'remove', 'replace'].includes(operation.op) &&
        typeof operation.path === 'string',
      'PATCH'
    );
    if (operation.op !== 'remove') protocol(own(operation, 'value'), 'PATCH');
    if (operation.path === '') {
      protocol(operation.op !== 'remove' && record(operation.value), 'PATCH_ROOT');
      result = structuredClone(operation.value);
      continue;
    }
    protocol(operation.path.startsWith('/'), 'PATCH_PATH');
    const parts = operation.path
      .slice(1)
      .split('/')
      .map((part) => {
        protocol(!/~(?:[^01]|$)/.test(part), 'PATCH_ESCAPE');
        const decoded = part.replaceAll('~1', '/').replaceAll('~0', '~');
        protocol(!unsafe.has(decoded), 'PATCH_PROTOTYPE');
        return decoded;
      });
    let parent = result;
    for (const key of parts.slice(0, -1)) {
      protocol((record(parent) || Array.isArray(parent)) && own(parent, key), 'PATCH_PARENT');
      parent = parent[key];
    }
    protocol(record(parent) || Array.isArray(parent), 'PATCH_PARENT');
    const key = parts.at(-1);
    if (Array.isArray(parent)) {
      const append = key === '-' && operation.op === 'add';
      protocol(append || /^(0|[1-9][0-9]*)$/.test(key), 'PATCH_INDEX');
      const index = append ? parent.length : Number(key);
      protocol(
        Number.isSafeInteger(index) &&
          index >= 0 &&
          index < parent.length + (operation.op === 'add' ? 1 : 0),
        'PATCH_INDEX'
      );
      if (operation.op === 'add') parent.splice(index, 0, structuredClone(operation.value));
      else if (operation.op === 'remove') parent.splice(index, 1);
      else parent[index] = structuredClone(operation.value);
    } else {
      if (operation.op !== 'add') protocol(own(parent, key), 'PATCH_MISSING');
      if (operation.op === 'remove') delete parent[key];
      else parent[key] = structuredClone(operation.value);
    }
  }
  return result;
}
