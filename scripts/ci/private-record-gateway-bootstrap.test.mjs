import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gatewayMachineIdSha256 } from './private-record-gateway-host-identity.mjs';
import { validateBootstrap, installBootstrap } from './private-record-gateway-bootstrap.mjs';
const input = () => ({
  revision: 'a'.repeat(40),
  runId: '123',
  engineMachineIdSha256: 'b'.repeat(64),
  publisherPublicKey: 'ssh-ed25519 AAAATEST qualification',
  trustedRoot: '{"mediaType":"trusted-root"}\n',
  environment: {
    PRIVATE_RECORD_GATEWAY_DATABASE_URL:
      'postgresql://ca_record_gateway:fixture@db.example:5432/postgres',
    SUPABASE_URL: 'https://kuklfnapbkmacvwxktbh.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'fixture-only',
  },
});
const state = () => ({
  caddy: Buffer.from('old aggregate'),
  caddyPreimage: Buffer.from('old aggregate'),
  replacementCaddy: Buffer.from('new aggregate'),
  originMachineIdSha256: 'c'.repeat(64),
  activeGateway: false,
  publisherExists: false,
  availableMemoryBytes: 2 * 1024 ** 3,
  availableDiskBytes: 2 * 1024 ** 3,
  staticIdentity: ['old-static'],
});
function fixture({ failStatic = false, raceAfterReload = false } = {}) {
  const original = state();
  let current = original.caddy;
  const calls = [];
  let checks = 0;
  const io = {
    inspect: () => original,
    reserve: () => calls.push('reserve'),
    validateSource: () => calls.push('validate'),
    installPrerequisites: () => calls.push('inert-prerequisites'),
    validateInstalled: () => calls.push('installed-validation'),
    readCaddy: () => current,
    writeCaddy: (v) => {
      current = v;
      calls.push(v.toString());
    },
    reloadCaddy: () => {
      calls.push('reload');
      if (raceAfterReload) current = Buffer.from('third-party');
    },
    verifyStaticIdentity: () => {
      if (failStatic && checks++ === 0) throw Error('static mismatch');
    },
    enableBoot: () => calls.push('enable-boot'),
    record: (receipt) => calls.push(receipt.phase),
  };
  return { io, calls, current: () => current.toString() };
}
test('missing dedicated connection or unverified TLS refuses before mutation', () => {
  for (const value of [
    '',
    'postgresql://u:p@db:6543/postgres',
    'postgresql://ca_record_gateway:p@db:5432/postgres?sslmode=require',
    'postgresql://postgres:p@db:5432/postgres',
  ]) {
    const config = input();
    config.environment.PRIVATE_RECORD_GATEWAY_DATABASE_URL = value;
    const f = fixture();
    assert.throws(() => installBootstrap(config, f.io));
    assert.deepEqual(f.calls, []);
  }
});
test('same host, active gateway, preimage drift and existing publisher refuse admission', () => {
  for (const patch of [
    { originMachineIdSha256: 'b'.repeat(64) },
    { activeGateway: true },
    { caddy: Buffer.from('unknown aggregate') },
    { publisherExists: true },
    { priorBootstrapFiles: true },
    { availableMemoryBytes: 0 },
    { availableDiskBytes: 0 },
  ])
    assert.throws(() => validateBootstrap(input(), { ...state(), ...patch }));
});
test('successful bootstrap validates before route and leaves gateway inactive', () => {
  const f = fixture();
  installBootstrap(input(), f.io);
  assert.deepEqual(f.calls, [
    'reserve',
    'validate',
    'inert-prerequisites',
    'installed-validation',
    'new aggregate',
    'reload',
    'enable-boot',
    'committed',
  ]);
});
test('failed static proof restores exact predecessor route and reports failure', () => {
  const f = fixture({ failStatic: true });
  assert.throws(() => installBootstrap(input(), f.io));
  assert.equal(f.current(), 'old aggregate');
  assert.ok(!f.calls.includes('enable-boot'));
  assert.equal(f.calls.at(-1), 'failed-inert');
});
test('rollback refuses to overwrite concurrent aggregate changes', () => {
  const f = fixture({ failStatic: true, raceAfterReload: true });
  assert.throws(() => installBootstrap(input(), f.io));
  assert.equal(f.current(), 'third-party');
  assert.equal(f.calls.at(-1), 'requires-explicit-recovery');
});
test('canonical config refuses multiline injection and unrecognized environment keys', () => {
  const a = input();
  a.environment.SUPABASE_SERVICE_ROLE_KEY = 'fixture\nOVERRIDE=1';
  assert.throws(() => validateBootstrap(a, state()));
  const b = input();
  b.environment.PRIVATE_RECORD_GATEWAY_SOCKET = '/tmp/override';
  assert.throws(() => validateBootstrap(b, state()));
});
test('dedicated privilege grant preserves estate identity and source is provider-only', () => {
  const sudoers = readFileSync(
    new URL('../../infra/ca-origin/ca-private-record-gateway.sudoers', import.meta.url),
    'utf8'
  );
  assert.match(
    sudoers,
    /ca-record-publisher ALL=\(root\) NOPASSWD: \/usr\/local\/libexec\/ca-private-record-gateway-activate \*/
  );
  assert.doesNotMatch(sudoers, /^ci ALL=/m);
  const source = readFileSync(
    new URL('./private-record-gateway-bootstrap.mjs', import.meta.url),
    'utf8'
  );
  assert.match(source, /process\.platform !== 'linux'/);
  assert.doesNotMatch(source, /systemctl.*\['start'/);
  assert.doesNotMatch(source, /DELETE FROM|supabase_enabled\s*=/i);
});

test('protected publisher selects bootstrap explicitly and uses distinct credential binding', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/publish-club-arena.yml', import.meta.url),
    'utf8'
  );
  const bootstrap = workflow.slice(workflow.indexOf('  bootstrap-record-gateway:'));
  assert.match(bootstrap, /outputs.component == 'private-record-bootstrap'/);
  assert.match(bootstrap, /secrets.CA_RECORD_GATEWAY_SSH_KEY/);
  assert.match(bootstrap, /secrets.PRIVATE_RECORD_GATEWAY_DB_PASSWORD/);
  assert.ok(
    bootstrap.indexOf('Required canonical configuration') < bootstrap.indexOf('sudo -n mkdir')
  );
  assert.match(bootstrap, /node --test scripts\/ci\/private-record-gateway-bootstrap.test.mjs/);
  const gate = readFileSync(
    new URL('../../.github/workflows/post-deploy-e2e.yml', import.meta.url),
    'utf8'
  );
  assert.match(
    gate,
    /Gateway bootstrap only; no gateway activation or client publication certified/
  );
});

test('bootstrap and activation use one normalized actual machine-id identity', () => {
  const id = '8de277067b3544d4b65c267d0edab928';
  assert.equal(gatewayMachineIdSha256(id), gatewayMachineIdSha256(id + '\n'));
  assert.equal(gatewayMachineIdSha256(id), gatewayMachineIdSha256(id.toUpperCase() + '\r\n'));
  assert.throws(() => gatewayMachineIdSha256('invalid'));
  for (const file of ['bootstrap', 'activate']) {
    const source = readFileSync(
      new URL(`./private-record-gateway-${file}.mjs`, import.meta.url),
      'utf8'
    );
    assert.match(
      source,
      /gatewayMachineIdSha256\((?:regular|readFileSync)\('\/etc\/machine-id'\)\)/
    );
  }
});
