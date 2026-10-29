import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { inspectHost } from './private-record-gateway-inspect.mjs';
import { gatewayMachineIdSha256 } from './private-record-gateway-host-identity.mjs';
const preimage = 'ca-static.smarter.poker {\n respond "retained static"\n}\n';
const encoded = Buffer.from(preimage).toString('base64');
function fixture(config = 'unrelated.example { respond "other" }\n' + preimage) {
  const reads = [];
  const metadata = [];
  const io = {
    readProtectedFile(path, maximum) {
      reads.push({ path, maximum });
      if (path === '/etc/caddy/Caddyfile') return Buffer.from(config);
      if (path === '/etc/machine-id') return Buffer.from('8de277067b3544d4b65c267d0edab928\n');
      if (path === '/proc/meminfo') return Buffer.from('MemAvailable: 123456 kB\n');
      throw Error('unexpected path');
    },
    metadata(path) {
      metadata.push(path);
      return { kind: 'file', uid: 0, mode: 0o600 };
    },
    availableDiskBytes: () => 123456789,
    nodeVersion: () => 'v22.22.0',
  };
  return { io, reads, metadata };
}
test('hashes aggregate bytes and counts exact reviewed site matches without printing them', () => {
  const config = 'unrelated secret-shaped marker { respond "preserved" }\n' + preimage;
  const f = fixture(config);
  const result = inspectHost(encoded, f.io);
  assert.equal(result.status, 'observed');
  assert.equal(result.caddy.sha256, createHash('sha256').update(config).digest('hex'));
  assert.equal(result.caddy.exactPreimageOccurrences, 1);
  assert.equal(result.machineIdSha256, gatewayMachineIdSha256('8de277067b3544d4b65c267d0edab928'));
  assert.equal(result.capacity.memory.availableBytes, 123456 * 1024);
  assert.ok(!JSON.stringify(result).includes('secret-shaped'));
  assert.ok(!JSON.stringify(result).includes('retained static'));
  assert.ok(JSON.stringify(result).length < 16384);
  assert.deepEqual(
    f.reads.map((entry) => entry.path),
    ['/etc/caddy/Caddyfile', '/etc/machine-id', '/proc/meminfo']
  );
  assert.ok(f.metadata.includes('/etc/club-arena/private-record-gateway.env'));
  assert.ok(!f.reads.some((entry) => /\.env|trusted-root|authorized_keys/.test(entry.path)));
});
test('zero and duplicate exact preimages remain explicit observations, never unique-route proof', () => {
  assert.equal(
    inspectHost(encoded, fixture('unknown aggregate').io).caddy.exactPreimageOccurrences,
    0
  );
  assert.equal(
    inspectHost(encoded, fixture(preimage + preimage).io).caddy.exactPreimageOccurrences,
    2
  );
});
test('strict base64, UTF8, size and argument input validation refuses before reads', () => {
  for (const input of [
    '',
    '/etc/passwd',
    '%%%%',
    encoded + '\n',
    Buffer.from([0xff]).toString('base64'),
    Buffer.from('x\0y').toString('base64'),
    'A'.repeat(1400000),
  ]) {
    const f = fixture();
    assert.throws(() => inspectHost(input, f.io), /INVALID_REVIEWED_PREIMAGE/);
    assert.equal(f.reads.length, 0);
  }
});
test('oversized or invalid core readback and machine identity refuse safely', () => {
  const large = fixture('x'.repeat(1024 * 1024 + 1));
  assert.throws(() => inspectHost(encoded, large.io), /INVALID_FILE_READBACK/);
  const empty = fixture('');
  assert.throws(() => inspectHost(encoded, empty.io), /EMPTY_CADDY_CONFIGURATION/);
  const invalid = fixture();
  const reader = invalid.io.readProtectedFile;
  invalid.io.readProtectedFile = (path, max) =>
    path === '/etc/machine-id' ? Buffer.from('not a machine id') : reader(path, max);
  assert.throws(() => inspectHost(encoded, invalid.io), /MACHINE_IDENTITY_UNAVAILABLE/);
});
test('permission-denied prerequisites and unknown capacity are unknown, not absent or zero', () => {
  const f = fixture();
  f.io.metadata = (path) => {
    const error = Error('sensitive error detail must not escape');
    error.code = path.endsWith('.env') ? 'EACCES' : 'ENOENT';
    throw error;
  };
  f.io.availableDiskBytes = () => NaN;
  const result = inspectHost(encoded, f.io);
  assert.equal(result.status, 'partial');
  assert.equal(result.capacity.disk.state, 'unknown');
  assert.equal(result.prerequisites.find((entry) => entry.path.endsWith('.env')).state, 'unknown');
  assert.equal(
    result.prerequisites.find((entry) => entry.path.endsWith('.service')).state,
    'absent'
  );
  assert.ok(!JSON.stringify(result).includes('sensitive error'));
});
test('fixed reader uses bounded no-follow descriptor reads and performs no writes or commands', () => {
  const source = readFileSync(
    new URL('./private-record-gateway-inspect.mjs', import.meta.url),
    'utf8'
  );
  assert.match(source, /constants\.O_RDONLY \| constants\.O_NOFOLLOW \| constants\.O_NONBLOCK/);
  assert.match(source, /!stat\.isFile\(\) \|\| stat\.uid !== 0/);
  assert.match(source, /stat\.size > maximum/);
  assert.match(source, /Buffer\.alloc\(maximum \+ 1\)/);
  assert.doesNotMatch(
    source,
    /node:child_process|writeFile|renameSync|unlinkSync|rmSync|process\.env|fetch\(|https:/
  );
});
test('CLI rejects extra path/command arguments with bounded JSON only', () => {
  let caught;
  try {
    execFileSync(
      process.execPath,
      [
        new URL('./private-record-gateway-inspect.mjs', import.meta.url).pathname,
        encoded,
        '/etc/passwd',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.status, 1);
  const result = JSON.parse(caught.stdout);
  assert.deepEqual(result, { schema: 1, status: 'unavailable', error: 'INVALID_ARGUMENTS' });
  assert.equal(caught.stderr, '');
});
