// Native kernel metadata only. This is a predicate for the owning release,
// never authority to attach, close a listener, or modify the engine.
import * as inspectorFs from 'node:fs';

const inspectorSocketRefusal = () => new Error('main_inspector_socket_unproved');
export const INSPECTOR_KERNEL_STEPS = Object.freeze([
  'members',
  'identities',
  'namespace',
  'socket_rows',
  'listener',
  'descriptors',
  'listener_owner',
  'clients',
  'identity_recheck',
  'snapshot_recheck',
  'binding_recheck',
]);
const inspectorNumericPid = /^[1-9][0-9]{0,9}$/;

function inspectorKernelRead(path, limit, deadlineMs) {
  if (Date.now() >= deadlineMs) throw inspectorSocketRefusal();
  const fd = inspectorFs.openSync(
    path,
    inspectorFs.constants.O_RDONLY | inspectorFs.constants.O_NOFOLLOW
  );
  try {
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    for (;;) {
      if (Date.now() >= deadlineMs || size > limit) throw inspectorSocketRefusal();
      const n = inspectorFs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!n) return bytes.subarray(0, size);
      size += n;
    }
  } finally {
    inspectorFs.closeSync(fd);
  }
}

function inspectorKernelStart(root, pid, deadlineMs) {
  // comm is opaque bytes and can contain spaces, parentheses and non-UTF8.
  // Decode only the ASCII suffix after its final closing parenthesis.
  const bytes = inspectorKernelRead(`${root}/${pid}/stat`, 4096, deadlineMs);
  const end = bytes.lastIndexOf(0x29);
  const prefix = Buffer.from(`${pid} (`);
  const tail = bytes.subarray(end + 1);
  if (
    end < prefix.length ||
    !bytes.subarray(0, prefix.length).equals(prefix) ||
    [...tail].some((byte) => byte > 0x7f)
  )
    throw inspectorSocketRefusal();
  const fields = tail.toString('ascii').trim().split(/\s+/);
  if (fields.length < 20 || !/^[A-Za-z]$/.test(fields[0]) || !/^[0-9]{1,20}$/.test(fields[19]))
    throw inspectorSocketRefusal();
  return fields[19];
}

function inspectorKernelNamespace(root, pid, deadlineMs) {
  if (Date.now() >= deadlineMs) throw inspectorSocketRefusal();
  const value = inspectorFs.readlinkSync(`${root}/${pid}/ns/net`);
  if (!/^net:\[[1-9][0-9]{0,19}\]$/.test(value)) throw inspectorSocketRefusal();
  return value;
}

function inspectorKernelMembers(root, deadlineMs) {
  if (Date.now() >= deadlineMs) throw inspectorSocketRefusal();
  const entries = inspectorFs.readdirSync(root).filter((value) => inspectorNumericPid.test(value));
  if (!entries.length || entries.length > 256) throw inspectorSocketRefusal();
  return entries.sort((a, b) => Number(a) - Number(b));
}

function inspectorKernelSockets(root, pid, port, deadlineMs) {
  const rows = [];
  for (const family of ['tcp', 'tcp6']) {
    const bytes = inspectorKernelRead(`${root}/${pid}/net/${family}`, 131072, deadlineMs);
    if ([...bytes].some((byte) => byte > 0x7f)) throw inspectorSocketRefusal();
    const lines = bytes.toString('ascii').trim().split('\n');
    if (!lines[0]?.includes('inode')) throw inspectorSocketRefusal();
    const width = family === 'tcp' ? 8 : 32;
    const endpointPattern = new RegExp(`^[0-9A-Fa-f]{${width}}:[0-9A-Fa-f]{4}$`);
    for (const line of lines.slice(1)) {
      if (Date.now() >= deadlineMs) throw inspectorSocketRefusal();
      const fields = line.trim().split(/\s+/);
      if (
        fields.length < 10 ||
        !endpointPattern.test(fields[1]) ||
        !endpointPattern.test(fields[2]) ||
        !/^[0-9A-Fa-f]{2}$/.test(fields[3]) ||
        !/^[0-9]{1,20}$/.test(fields[9])
      )
        throw inspectorSocketRefusal();
      const local = fields[1].toUpperCase(),
        remote = fields[2].toUpperCase();
      if (parseInt(local.slice(-4), 16) !== port && parseInt(remote.slice(-4), 16) !== port)
        continue;
      const state = fields[3].toUpperCase();
      // A completed HTTP discovery can leave ownerless TIME_WAIT. It cannot
      // accept debugger commands and is never treated as a live client.
      if (state === '06' && fields[9] === '0') continue;
      rows.push({ family, local, remote, state, inode: fields[9] });
      if (rows.length > 8) throw inspectorSocketRefusal();
    }
  }
  return rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function inspectorKernelSnapshot({
  root,
  pid,
  port,
  deadlineMs,
  allowOwnClient,
  budget,
  diagnostic,
}) {
  diagnostic.step = 'members';
  const members = inspectorKernelMembers(root, deadlineMs);
  if (!members.includes(String(pid)) || !members.includes(String(process.pid)))
    throw inspectorSocketRefusal();
  diagnostic.step = 'identities';
  const identities = members.map((member) => ({
    pid: member,
    startTicks: inspectorKernelStart(root, member, deadlineMs),
    namespace: inspectorKernelNamespace(root, member, deadlineMs),
  }));
  const main = identities.find((value) => value.pid === String(pid));
  // A complete, single-network-namespace census is required. An unknown or
  // hidden member is not an empty descriptor set.
  diagnostic.step = 'namespace';
  if (identities.some((value) => value.namespace !== main.namespace))
    throw inspectorSocketRefusal();
  diagnostic.step = 'socket_rows';
  const rows = inspectorKernelSockets(root, pid, port, deadlineMs);
  diagnostic.step = 'listener';
  const listeners = rows.filter((row) => row.state === '0A');
  if (listeners.length !== 1) throw inspectorSocketRefusal();
  const listener = listeners[0];
  const loopback = listener.family === 'tcp' ? '0100007F' : '00000000000000000000000001000000';
  const zero = '0'.repeat(loopback.length) + ':0000';
  if (
    listener.local !== `${loopback}:${(0x10000 + port).toString(16).slice(1).toUpperCase()}` ||
    listener.remote !== zero ||
    listener.inode === '0'
  )
    throw inspectorSocketRefusal();
  diagnostic.step = 'descriptors';
  const owners = new Map(rows.map((row) => [row.inode, new Set()]));
  for (const member of members) {
    if (Date.now() >= deadlineMs) throw inspectorSocketRefusal();
    // Keep the directory handle open during the census. Enumerating our own
    // /proc/<pid>/fd with readdirSync would list its already-closed transient
    // directory descriptor and incorrectly turn every own-client proof unknown.
    const directory = inspectorFs.opendirSync(`${root}/${member}/fd`);
    try {
      for (let entry; (entry = directory.readSync()) !== null; ) {
        const fd = entry.name;
        if (Date.now() >= deadlineMs || ++budget.fds > 16384 || !/^[0-9]{1,10}$/.test(fd))
          throw inspectorSocketRefusal();
        const value = inspectorFs.readlinkSync(`${root}/${member}/fd/${fd}`);
        if (value.length > 4096) throw inspectorSocketRefusal();
        const socket = /^socket:\[([0-9]{1,20})\]$/.exec(value);
        if (socket && owners.has(socket[1])) owners.get(socket[1]).add(member);
      }
    } finally {
      directory.closeSync();
    }
  }
  const solely = (inode, owner) => {
    const values = owners.get(inode);
    return values?.size === 1 && values.has(String(owner));
  };
  diagnostic.step = 'listener_owner';
  if (!solely(listener.inode, pid)) throw inspectorSocketRefusal();
  diagnostic.step = 'clients';
  const clients = rows.filter((row) => row !== listener);
  if (!allowOwnClient) {
    if (clients.length) throw inspectorSocketRefusal();
  } else {
    if (clients.length !== 2) throw inspectorSocketRefusal();
    const server = clients.find(
      (row) => row.family === listener.family && row.local === listener.local
    );
    const client = clients.find((row) => row !== server);
    if (
      !server ||
      !client ||
      server.state !== '01' ||
      client.state !== '01' ||
      server.family !== client.family ||
      server.remote !== client.local ||
      server.local !== client.remote ||
      !server.remote.startsWith(`${loopback}:`) ||
      server.inode === client.inode ||
      !solely(server.inode, pid) ||
      !solely(client.inode, process.pid)
    )
      throw inspectorSocketRefusal();
  }
  diagnostic.step = 'identity_recheck';
  for (const identity of identities) {
    if (
      inspectorKernelStart(root, identity.pid, deadlineMs) !== identity.startTicks ||
      inspectorKernelNamespace(root, identity.pid, deadlineMs) !== identity.namespace
    )
      throw inspectorSocketRefusal();
  }
  diagnostic.step = 'snapshot_recheck';
  if (
    JSON.stringify(inspectorKernelMembers(root, deadlineMs)) !== JSON.stringify(members) ||
    JSON.stringify(inspectorKernelSockets(root, pid, port, deadlineMs)) !== JSON.stringify(rows)
  )
    throw inspectorSocketRefusal();
  return {
    identities,
    rows,
    binding: {
      schema: 'main-inspector-socket-binding/v1',
      pid,
      startTicks: main.startTicks,
      namespace: main.namespace,
      listener: { family: listener.family, local: listener.local, inode: listener.inode },
    },
  };
}

export function captureMainInspectorBinding({
  pid = 1,
  port = 9229,
  deadlineMs,
  allowOwnClient = false,
  expectedBinding = null,
  procRoot = '/proc',
} = {}) {
  if (
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    pid === process.pid ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs <= Date.now() ||
    typeof allowOwnClient !== 'boolean' ||
    typeof procRoot !== 'string' ||
    !procRoot.startsWith('/')
  )
    throw inspectorSocketRefusal();
  const diagnostic = { step: 'members' };
  try {
    const options = {
      root: procRoot,
      pid,
      port,
      deadlineMs,
      allowOwnClient,
      budget: { fds: 0 },
      diagnostic,
    };
    const before = inspectorKernelSnapshot(options);
    const after = inspectorKernelSnapshot(options);
    diagnostic.step = 'binding_recheck';
    if (
      Date.now() >= deadlineMs ||
      JSON.stringify(before) !== JSON.stringify(after) ||
      (expectedBinding !== null &&
        JSON.stringify(before.binding) !== JSON.stringify(expectedBinding))
    )
      throw inspectorSocketRefusal();
    return Object.freeze({ ...before.binding, listener: Object.freeze(before.binding.listener) });
  } catch {
    // Only the fixed predicate name crosses this boundary. All native metadata
    // remains private; refusal, deadlines and qualification are unchanged.
    const refusal = inspectorSocketRefusal();
    refusal.kernelStep = diagnostic.step;
    throw refusal;
  }
}
