import { lstat, realpath, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { basename, dirname, resolve } from 'node:path';

/** Refuse ambiguous ownership or liveness; recover only this generation's dead socket. */
export async function preparePrivateRecordGatewaySocket(socketPath: string): Promise<void> {
  const directory = dirname(socketPath);
  const uid = process.getuid?.();
  if (uid === undefined || basename(socketPath) !== 'listener.sock')
    throw new Error('gateway socket ownership unavailable');
  const parent = await lstat(directory);
  if (
    !parent.isDirectory() ||
    parent.uid !== uid ||
    (parent.mode & 0o022) !== 0 ||
    (await realpath(directory)) !== resolve(directory)
  )
    throw new Error('gateway generation directory ownership mismatch');
  let original;
  try {
    original = await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!original.isSocket() || original.uid !== uid)
    throw new Error('gateway socket is not an owned socket');
  await new Promise<void>((resolveProbe, reject) => {
    const probe = createConnection(socketPath);
    const timer = setTimeout(() => {
      probe.destroy();
      reject(new Error('gateway socket liveness unknown'));
    }, 1000);
    probe.once('connect', () => {
      clearTimeout(timer);
      probe.destroy();
      reject(new Error('gateway socket already has a live listener'));
    });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      probe.destroy();
      if (error.code === 'ECONNREFUSED') resolveProbe();
      else reject(new Error('gateway socket liveness unknown', { cause: error }));
    });
  });
  const current = await lstat(socketPath);
  if (
    !current.isSocket() ||
    current.uid !== uid ||
    current.dev !== original.dev ||
    current.ino !== original.ino ||
    current.ctimeMs !== original.ctimeMs
  )
    throw new Error('gateway socket changed during liveness check');
  await unlink(socketPath);
}
