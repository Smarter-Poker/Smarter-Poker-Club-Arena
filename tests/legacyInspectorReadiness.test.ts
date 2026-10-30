import { createServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const transaction = readFileSync('server/scripts/engine-release-transaction.sh', 'utf8');
const helper = transaction.slice(
  transaction.indexOf('legacy_inspector_is_closed() {'),
  transaction.indexOf('\nrequest_recovery_window() {')
);
const script = helper.split("' checkpoint-readiness -e '\n")[1].split("\n'\n}")[0];

async function probe(port: number) {
  const child = spawn(process.execPath, ['-e', script.replace('port:9229', `port:${port}`)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (bytes) => (output += bytes));
  child.stderr.on('data', (bytes) => (output += bytes));
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    return { status, output };
  } finally {
    clearTimeout(timer);
  }
}

describe('legacy inspector readiness before a recovery announcement', () => {
  it.each([false, true])(
    'requires positive listener absence; listener present=%s',
    async (present) => {
      const connections = new Set<Socket>();
      let receivedBytes = 0;
      const server = createServer((socket) => {
        connections.add(socket);
        socket.on('data', (bytes) => (receivedBytes += bytes.length));
        socket.on('close', () => connections.delete(socket));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('fixture address missing');
      if (!present) await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        expect(await probe(address.port)).toEqual({ status: present ? 1 : 0, output: '' });
        expect(receivedBytes).toBe(0);
        expect(server.listening).toBe(present);
      } finally {
        for (const socket of connections) socket.destroy();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );

  it('keeps the probe read-only and before the one durable announcement reservation', () => {
    expect(helper).toContain('env -u NODE_OPTIONS -u NODE_PATH node --no-inspect "$@"');
    expect(helper).toContain('case "${NODE_OPTIONS-}" in *--inspect*|*--debug*) exit 1 ;; esac');
    expect(script).toContain('host:"127.0.0.1",port:9229');
    expect(script).not.toMatch(/SIGUSR|Runtime\.|inspector\.close|\.write\(|\.send\(/);
    const request = transaction.slice(
      transaction.indexOf('\nrequest_recovery_window() {'),
      transaction.indexOf('\npersist_break_deadline() {')
    );
    expect(request.indexOf('! legacy_inspector_is_closed')).toBeGreaterThan(
      request.indexOf('source_target_is_current')
    );
    expect(request.indexOf('! legacy_inspector_is_closed')).toBeLessThan(
      request.indexOf('reserve-recovery-window')
    );
    expect(request).toContain('no recovery window requested and no inspector was touched');
  });
});
