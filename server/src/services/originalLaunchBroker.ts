import { createConnection } from 'node:net';

export interface OriginalLaunchUnknown {
  readonly kind: 'unknown';
  readonly reason: string;
  readonly startAuthority: false;
  readonly noStartAuthority: false;
  readonly financialMutationAuthority: false;
}

const SOCKET_PATH = '/run/club-arena-original-launch/broker.sock';
const FRAME_LIMIT = 4096;
const reasons = new Set([
  'canonical_registration_unavailable',
  'peer_unproven',
  'persistence_unavailable',
  'request_refused',
]);
const unavailable = (reason: string): OriginalLaunchUnknown =>
  Object.freeze({
    kind: 'unknown',
    reason,
    startAuthority: false,
    noStartAuthority: false,
    financialMutationAuthority: false,
  });

export function decodeOriginalLaunchReply(raw: Uint8Array): OriginalLaunchUnknown {
  if (raw.byteLength === 0 || raw.byteLength > FRAME_LIMIT)
    return unavailable('broker_response_refused');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return unavailable('broker_response_refused');
    const expected = [
      'financialMutationAuthority',
      'kind',
      'noStartAuthority',
      'reason',
      'startAuthority',
    ];
    const keys = Object.keys(value).sort();
    if (
      JSON.stringify(keys) !== JSON.stringify(expected) ||
      value.kind !== 'unknown' ||
      !reasons.has(value.reason) ||
      value.startAuthority !== false ||
      value.noStartAuthority !== false ||
      value.financialMutationAuthority !== false
    )
      return unavailable('broker_response_refused');
    // The broker emits canonical JSON. Reject duplicates, trailing records and
    // ambiguous encodings rather than normalizing them into a trusted result.
    const canonical =
      JSON.stringify(Object.fromEntries(keys.map((key) => [key, value[key]]))) + '\n';
    if (text !== canonical) return unavailable('broker_response_refused');
    return unavailable(value.reason);
  } catch {
    return unavailable('broker_response_refused');
  }
}

/** No identity, bearer token, PID or signing key can be supplied by a caller.
 * Never cache across process boots or reinterpret local persistence as an ACK.
 * The current inactive component deliberately has no successful session path.
 */
export function acquireOriginalLaunch(): Promise<OriginalLaunchUnknown> {
  return new Promise((resolve) => {
    const socket = createConnection({ path: SOCKET_PATH });
    const chunks: Buffer[] = [];
    let size = 0;
    let result = unavailable('broker_transport_unavailable');
    let finished = false;
    const finish = (value: OriginalLaunchUnknown) => {
      if (finished) return;
      finished = true;
      result = value;
      socket.destroy();
    };
    const timer = setTimeout(() => finish(unavailable('broker_transport_timeout')), 3000);
    socket.once('connect', () =>
      socket.write('{"version":1,"operation":"acquireOriginalLaunch"}\n')
    );
    socket.on('data', (chunk: Buffer) => {
      if (finished) return;
      size += chunk.length;
      if (size > FRAME_LIMIT) return finish(unavailable('broker_response_refused'));
      chunks.push(chunk);
      if (chunk.includes(10)) finish(decodeOriginalLaunchReply(Buffer.concat(chunks)));
    });
    socket.once('end', () => finish(unavailable('broker_response_incomplete')));
    socket.once('error', () => finish(unavailable('broker_transport_unavailable')));
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(result); // Observe actual socket close before returning to bootstrap.
    });
  });
}

/** Draft bootstrap seam: default remains inactive. Enabling this incomplete
 * component can only refuse admission; Accounting has not supplied its commit
 * authority yet. Production installation/activation is expressly excluded.
 */
export async function assertOriginalLaunchRegistration(): Promise<void> {
  const required = process.env.F06_ORIGINAL_LAUNCH_REQUIRED;
  if (required === undefined || required === '0') return;
  if (required !== '1') throw new Error('ORIGINAL_LAUNCH_CONFIGURATION_REFUSED');
  await acquireOriginalLaunch();
  throw new Error('ORIGINAL_LAUNCH_CANONICAL_REGISTRATION_UNAVAILABLE');
}
