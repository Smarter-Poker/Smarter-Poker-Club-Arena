import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const transport = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('node:net', () => ({ createConnection: transport.connect }));
import {
  acquireOriginalLaunch,
  assertOriginalLaunchRegistration,
  decodeOriginalLaunchReply,
} from './originalLaunchBroker.js';

const reply = {
  financialMutationAuthority: false,
  kind: 'unknown',
  noStartAuthority: false,
  reason: 'canonical_registration_unavailable',
  startAuthority: false,
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('inactive launch broker cannot mint a successful session', () => {
  it('retains canonical-unavailable as unknown with every authority false', () => {
    expect(decodeOriginalLaunchReply(encode(reply))).toEqual(reply);
  });
  it.each([
    ['start authority', encode({ ...reply, startAuthority: true })],
    ['cold authority', encode({ ...reply, noStartAuthority: true })],
    ['money authority', encode({ ...reply, financialMutationAuthority: true })],
    ['fake commit ACK', encode({ ...reply, kind: 'original_launch_ack' })],
    ['caller identity', encode({ ...reply, pid: 123 })],
    ['multiple replies', Buffer.concat([encode(reply), encode(reply)])],
    ['duplicate key', Buffer.from(JSON.stringify(reply).slice(0, -1) + ',"kind":"unknown"}\n')],
    ['invalid UTF8', Buffer.from([0xff, 10])],
    ['unbounded reply', Buffer.alloc(4097, 32)],
  ])('rejects %s without granting any authority', (_label, bytes) => {
    expect(decodeOriginalLaunchReply(bytes)).toEqual({
      ...reply,
      reason: 'broker_response_refused',
    });
  });
  it('keeps the absent feature inactive without opening a socket', async () => {
    vi.stubEnv('F06_ORIGINAL_LAUNCH_REQUIRED', undefined);
    await assertOriginalLaunchRegistration();
    expect(transport.connect).not.toHaveBeenCalled();
  });
  it('rejects an invalid activation value before transport', async () => {
    vi.stubEnv('F06_ORIGINAL_LAUNCH_REQUIRED', 'true');
    await expect(assertOriginalLaunchRegistration()).rejects.toThrow('CONFIGURATION_REFUSED');
    expect(transport.connect).not.toHaveBeenCalled();
  });
  it('sends only the operation and waits for actual local socket close', async () => {
    const socket = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn() });
    transport.connect.mockReturnValue(socket);
    let settled = false;
    const pending = acquireOriginalLaunch().then((value) => {
      settled = true;
      return value;
    });
    expect(transport.connect).toHaveBeenCalledWith({
      path: '/run/club-arena-original-launch/broker.sock',
    });
    socket.emit('connect');
    expect(socket.write).toHaveBeenCalledWith(
      '{"version":1,"operation":"acquireOriginalLaunch"}\n'
    );
    socket.emit('data', encode(reply));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    socket.emit('close');
    expect(await pending).toEqual(reply);
  });
  it('does not treat a lost reply as committed registration', async () => {
    const socket = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn() });
    transport.connect.mockReturnValue(socket);
    const pending = acquireOriginalLaunch();
    socket.emit('connect');
    socket.emit('end');
    socket.emit('close');
    expect(await pending).toEqual({ ...reply, reason: 'broker_response_incomplete' });
  });
  it('requires a new handshake on each required bootstrap, and refuses unavailable authority', async () => {
    vi.stubEnv('F06_ORIGINAL_LAUNCH_REQUIRED', '1');
    transport.connect.mockImplementation(() => {
      const socket = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn() });
      socket.destroy.mockImplementation(() => queueMicrotask(() => socket.emit('close')));
      queueMicrotask(() => {
        socket.emit('connect');
        socket.emit('data', encode(reply));
      });
      return socket;
    });
    await expect(assertOriginalLaunchRegistration()).rejects.toThrow(
      'CANONICAL_REGISTRATION_UNAVAILABLE'
    );
    await expect(assertOriginalLaunchRegistration()).rejects.toThrow(
      'CANONICAL_REGISTRATION_UNAVAILABLE'
    );
    expect(transport.connect).toHaveBeenCalledTimes(2);
  });
});
