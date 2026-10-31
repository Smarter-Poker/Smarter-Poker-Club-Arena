import { afterEach, describe, expect, it } from 'vitest';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile, lstat, chmod } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { preparePrivateRecordGatewaySocket } from './privateRecordGatewaySocket.js';

const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});
async function fixture() {
  // Unix sockets need a short path. This remains on the required external SSD.
  const directory = await mkdtemp(
    join(process.platform === 'darwin' ? '/Volumes/SmarterWork/agent-work' : tmpdir(), 'gs-')
  );
  directories.push(directory);
  await chmod(directory, 0o700);
  return { directory, socket: join(directory, 'listener.sock') };
}
async function listener(directory: string, socket: string) {
  const script = join(directory, 'listener.mjs');
  const helper = new URL('./privateRecordGatewaySocket.ts', import.meta.url).href;
  await writeFile(
    script,
    `import {createServer} from 'node:net';
import {preparePrivateRecordGatewaySocket} from ${JSON.stringify(helper)};
await preparePrivateRecordGatewaySocket(process.argv[2]);
createServer(s=>s.end()).listen(process.argv[2],()=>process.send('ready'));`
  );
  const child = fork(script, [socket], { execArgv: ['--import', 'tsx'], silent: true });
  children.push(child);
  await Promise.race([
    once(child, 'message').then(([message]) => expect(message).toBe('ready')),
    once(child, 'exit').then(([code, signal]) => {
      throw new Error(`listener exited ${code}/${signal}`);
    }),
  ]);
  return child;
}
describe('private record gateway owned socket recovery', () => {
  it('restarts the same generation after SIGKILL and refuses its live listener', async () => {
    const { directory, socket } = await fixture();
    const first = await listener(directory, socket);
    await expect(preparePrivateRecordGatewaySocket(socket)).rejects.toThrow('live listener');
    first.kill('SIGKILL');
    await once(first, 'exit');
    expect((await lstat(socket)).isSocket()).toBe(true);
    // The original raw listen reproduces the failure against the SIGKILL residue.
    await expect(
      promisify(execFile)(process.execPath, [
        '-e',
        "require('node:net').createServer().listen(process.argv[1])",
        socket,
      ])
    ).rejects.toThrow('EADDRINUSE');
    await listener(directory, socket);
    await expect(preparePrivateRecordGatewaySocket(socket)).rejects.toThrow('live listener');
  });
  it('preserves regular files, symlinks and writable generation directories', async () => {
    const { directory, socket } = await fixture();
    await writeFile(socket, 'preserve');
    await expect(preparePrivateRecordGatewaySocket(socket)).rejects.toThrow('owned socket');
    expect((await lstat(socket)).isFile()).toBe(true);
    await rm(socket);
    await symlink(join(directory, 'foreign'), socket);
    await expect(preparePrivateRecordGatewaySocket(socket)).rejects.toThrow('owned socket');
    expect((await lstat(socket)).isSymbolicLink()).toBe(true);
    await rm(socket);
    await chmod(directory, 0o770);
    await expect(preparePrivateRecordGatewaySocket(socket)).rejects.toThrow('directory ownership');
  });
});
