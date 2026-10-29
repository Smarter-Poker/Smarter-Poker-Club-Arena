import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  chmodSync,
  chownSync,
  openSync,
  fsyncSync,
  closeSync,
  statfsSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gatewayMachineIdSha256 } from './private-record-gateway-host-identity.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha = /^[a-f0-9]{64}$/;
const mappings = [
  [
    'infra/ca-origin/ca-private-record-gateway@.service',
    '/etc/systemd/system/ca-private-record-gateway@.service',
    0o644,
  ],
  [
    'infra/ca-origin/ca-private-record-gateway-boot.service',
    '/etc/systemd/system/ca-private-record-gateway-boot.service',
    0o644,
  ],
  [
    'infra/ca-origin/ca-private-record-gateway.tmpfiles',
    '/etc/tmpfiles.d/ca-private-record-gateway.conf',
    0o644,
  ],
  [
    'infra/ca-origin/ca-private-record-gateway.sudoers',
    '/etc/sudoers.d/ca-private-record-gateway',
    0o440,
  ],
  [
    'infra/ca-origin/ca-private-record-gateway-activate',
    '/usr/local/libexec/ca-private-record-gateway-activate',
    0o755,
  ],
  ...['activate', 'artifact', 'boot', 'host-identity'].map((kind) => [
    `scripts/ci/private-record-gateway-${kind}.mjs`,
    `/usr/local/lib/ca-private-record-gateway/private-record-gateway-${kind}.mjs`,
    0o644,
  ]),
];

/** Validate all canonical inputs before any root mutation. Never return secrets. */
export function validateBootstrap(input, state) {
  if (!/^[a-f0-9]{40}$/.test(input.revision ?? '') || !/^[0-9]+$/.test(input.runId ?? ''))
    throw new Error('invalid bootstrap operation identity');
  if (
    !sha.test(input.engineMachineIdSha256 ?? '') ||
    input.engineMachineIdSha256 === state.originMachineIdSha256
  )
    throw new Error('independent engine identity not established');
  if (state.priorBootstrapFiles)
    throw new Error(
      'existing gateway prerequisites require explicit recovery, not first-install overwrite'
    );
  if (state.activeGateway) throw new Error('bootstrap cannot modify an active gateway');
  if (digest(state.caddy) !== digest(state.caddyPreimage))
    throw new Error(
      'aggregate Caddy preimage changed; preserve it and review a new exact source preimage'
    );
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/.test(input.publisherPublicKey ?? ''))
    throw new Error('dedicated publisher public key required');
  if (
    !input.trustedRoot ||
    !input.trustedRoot
      .trim()
      .split('\n')
      .every((line) => {
        try {
          return typeof JSON.parse(line) === 'object';
        } catch {
          return false;
        }
      })
  )
    throw new Error('independently retrieved trusted roots required');
  const environment = input.environment;
  const keys = ['PRIVATE_RECORD_GATEWAY_DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  if (!environment || Object.keys(environment).sort().join() !== keys.sort().join())
    throw new Error('exact canonical gateway configuration required');
  if (
    Object.values(environment).some(
      (value) => typeof value !== 'string' || !value || /[\r\n\0]/.test(value)
    )
  )
    throw new Error('invalid canonical gateway configuration');
  let database, api;
  try {
    database = new URL(environment.PRIVATE_RECORD_GATEWAY_DATABASE_URL);
    api = new URL(environment.SUPABASE_URL);
  } catch {
    throw new Error('invalid canonical gateway endpoint');
  }
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !/^ca_record_gateway(?:\.kuklfnapbkmacvwxktbh)?$/.test(decodeURIComponent(database.username)) ||
    !database.password ||
    database.port === '6543' ||
    [...database.searchParams.keys()].some((key) => /^ssl/i.test(key))
  )
    throw new Error(
      'dedicated session/direct connection without URL SSL overrides required; verified TLS is supplied by the maintained session opener'
    );
  if (
    api.hostname !== 'kuklfnapbkmacvwxktbh.supabase.co' ||
    api.pathname !== '/' ||
    api.protocol !== 'https:' ||
    api.username ||
    api.password ||
    api.search ||
    api.hash
  )
    throw new Error('HTTPS Supabase endpoint required');
  if (state.availableMemoryBytes < 1024 ** 3 || state.availableDiskBytes < 1024 ** 3)
    throw new Error('two-generation bootstrap capacity is insufficient');
  if (state.publisherExists)
    throw new Error('first-install bootstrap refuses an existing publisher account');
  return {
    schema: 1,
    component: 'private-record-bootstrap',
    revision: input.revision,
    runId: input.runId,
    caddyBeforeSha256: digest(state.caddy),
    caddyAfterSha256: digest(state.replacementCaddy),
    originMachineIdSha256: state.originMachineIdSha256,
    engineMachineIdSha256: input.engineMachineIdSha256,
  };
}

/** Route configuration is compare-and-swap; rollback never overwrites a third party. */
export function installBootstrap(input, io) {
  const state = io.inspect();
  const receipt = validateBootstrap(input, state);
  io.reserve(receipt);
  let routeChanged = false;
  try {
    io.validateSource();
    io.installPrerequisites(input, receipt);
    io.validateInstalled();
    if (digest(io.readCaddy()) !== receipt.caddyBeforeSha256)
      throw new Error('Caddy changed during bootstrap');
    io.writeCaddy(state.replacementCaddy);
    routeChanged = true;
    io.reloadCaddy();
    io.verifyStaticIdentity(state.staticIdentity);
    io.enableBoot();
    io.record({ ...receipt, phase: 'committed', gatewayStarted: false, paidSourceChanged: false });
    return receipt;
  } catch (error) {
    let recoveryRequired = false;
    if (routeChanged) {
      if (digest(io.readCaddy()) === receipt.caddyAfterSha256) {
        try {
          io.writeCaddy(state.caddy);
          io.reloadCaddy();
          io.verifyStaticIdentity(state.staticIdentity);
        } catch {
          recoveryRequired = true;
        }
      } else recoveryRequired = true;
    }
    // Prerequisites are inert; do not delete unknown/shared users or credential files.
    io.record({
      ...receipt,
      phase: recoveryRequired ? 'requires-explicit-recovery' : 'failed-inert',
      gatewayStarted: false,
      paidSourceChanged: false,
    });
    throw new Error(
      recoveryRequired
        ? 'bootstrap failed; exact operation needs explicit recovery'
        : 'bootstrap failed; gateway was not started'
    );
  }
}

function productionIo(source, input) {
  const caddyPath = '/etc/caddy/Caddyfile';
  const root = '/srv/ca-private-record-gateway';
  const run = (command, args) =>
    execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
  const regular = (path) => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022)
      throw new Error('nonregular bootstrap input');
    return readFileSync(path);
  };
  const atomic = (path, bytes, mode = 0o644) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new Error('symlink destination refused');
    const temporary = `${path}.bootstrap-${input.runId}`;
    writeFileSync(temporary, bytes, { mode, flag: 'wx' });
    chownSync(temporary, 0, 0);
    chmodSync(temporary, mode);
    renameSync(temporary, path);
    const file = openSync(path, 'r');
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  };
  const staticIdentity = () =>
    [
      'https://ca-static.smarter.poker/build-info.json',
      'https://smarter.poker/hub/club-arena/build-info.json',
    ].map((url) => {
      const value = JSON.parse(
        run('/usr/bin/curl', [
          '--fail',
          '--silent',
          '--show-error',
          '--max-time',
          '15',
          '--header',
          'Cache-Control: no-cache',
          url,
        ])
      );
      if (!/^[a-f0-9]{40}$/.test(value.ca_sha ?? value.sha ?? value.commit ?? value.gitSha ?? ''))
        throw new Error('static origin identity unavailable');
      return JSON.stringify(value);
    });
  let ledger;
  return {
    inspect() {
      let publisherExists = false;
      try {
        run('/usr/bin/id', ['ca-record-publisher']);
        publisherExists = true;
      } catch {}
      const storage = statfsSync('/srv');
      const availableMemoryBytes =
        Number(
          readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB$/m)?.[1] ?? 0
        ) * 1024;
      return {
        availableMemoryBytes,
        availableDiskBytes: Number(storage.bavail) * Number(storage.bsize),
        caddy: regular(caddyPath),
        caddyPreimage: regular(
          resolve(source, 'infra/ca-origin/private-record-gateway.caddy-preimage')
        ),
        replacementCaddy: regular(resolve(source, 'infra/ca-origin/Caddyfile')),
        originMachineIdSha256: gatewayMachineIdSha256(regular('/etc/machine-id')),
        activeGateway:
          existsSync(`${root}/active-release.json`) ||
          existsSync('/run/ca-private-record-gateway/active.sock'),
        publisherExists,
        priorBootstrapFiles:
          existsSync('/etc/club-arena/private-record-gateway.env') ||
          existsSync('/usr/local/libexec/ca-private-record-gateway-activate'),
        staticIdentity: staticIdentity(),
      };
    },
    reserve(receipt) {
      mkdirSync(root, { recursive: true, mode: 0o755 });
      mkdirSync(`${root}/bootstrap.lock`, { mode: 0o700 });
      ledger = `${root}/bootstrap-${input.runId}.json`;
      if (existsSync(ledger)) throw new Error('bootstrap operation already exists');
      atomic(ledger, JSON.stringify({ ...receipt, phase: 'reserved' }) + '\n', 0o600);
    },
    validateSource() {
      for (const [from] of mappings) regular(resolve(source, from));
      const [major, minor] = process.versions.node.split('.').map(Number);
      if (major < 20 || (major === 20 && minor < 19))
        throw new Error('unsupported gateway Node runtime');
      run('/usr/bin/python3', ['--version']);
      const attestationHelp = run('/usr/bin/gh', ['attestation', 'verify', '--help']);
      for (const flag of [
        '--custom-trusted-root',
        '--deny-self-hosted-runners',
        '--source-ref',
        '--signer-workflow',
      ])
        if (!attestationHelp.includes(flag))
          throw new Error('offline attestation capability missing');
      run('/usr/bin/caddy', [
        'validate',
        '--config',
        resolve(source, 'infra/ca-origin/Caddyfile'),
        '--adapter',
        'caddyfile',
      ]);
      run('/usr/sbin/visudo', [
        '-cf',
        resolve(source, 'infra/ca-origin/ca-private-record-gateway.sudoers'),
      ]);
      run('/usr/bin/systemd-analyze', [
        'verify',
        resolve(source, 'infra/ca-origin/ca-private-record-gateway@.service'),
        resolve(source, 'infra/ca-origin/ca-private-record-gateway-boot.service'),
      ]);
    },
    installPrerequisites(config, receipt) {
      run('/usr/bin/getent', ['group', 'caddy']);
      try {
        run('/usr/bin/id', ['ca-record-gateway']);
      } catch {
        run('/usr/sbin/useradd', [
          '--system',
          '--no-create-home',
          '--shell',
          '/usr/sbin/nologin',
          'ca-record-gateway',
        ]);
      }
      run('/usr/sbin/useradd', [
        '--system',
        '--create-home',
        '--home-dir',
        '/var/lib/ca-record-publisher',
        '--shell',
        '/bin/sh',
        'ca-record-publisher',
      ]);
      const publisherUid = Number(run('/usr/bin/id', ['-u', 'ca-record-publisher']).trim());
      const publisherGid = Number(run('/usr/bin/id', ['-g', 'ca-record-publisher']).trim());
      for (const path of [`${root}/releases`, `${root}/incoming`, '/run/ca-private-record-gateway'])
        mkdirSync(path, { recursive: true, mode: 0o755 });
      chownSync(`${root}/incoming`, publisherUid, publisherGid);
      const ssh = '/var/lib/ca-record-publisher/.ssh';
      mkdirSync(ssh, { mode: 0o700 });
      atomic(`${ssh}/authorized_keys`, `restrict ${config.publisherPublicKey}\n`, 0o600);
      chownSync(ssh, publisherUid, publisherGid);
      chownSync(`${ssh}/authorized_keys`, publisherUid, publisherGid);
      for (const [from, to, mode] of mappings) atomic(to, regular(resolve(source, from)), mode);
      atomic('/etc/club-arena/github-actions-trusted-root.jsonl', config.trustedRoot, 0o600);
      atomic(
        '/etc/club-arena/private-record-gateway-host.json',
        JSON.stringify({
          originMachineIdSha256: receipt.originMachineIdSha256,
          engineMachineIdSha256: receipt.engineMachineIdSha256,
          independentHostVerified: true,
        }) + '\n',
        0o600
      );
      atomic(
        '/etc/club-arena/private-record-gateway.env',
        Object.entries(config.environment)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join('\n') + '\n',
        0o600
      );
    },
    validateInstalled() {
      run('/usr/sbin/visudo', ['-cf', '/etc/sudoers.d/ca-private-record-gateway']);
      const grants = run('/usr/bin/sudo', ['-n', '-l', '-U', 'ca-record-publisher']);
      if (/NOPASSWD:\s*ALL/.test(grants))
        throw new Error('dedicated publisher has unrestricted sudo');
      run('/usr/bin/systemd-tmpfiles', [
        '--create',
        '/etc/tmpfiles.d/ca-private-record-gateway.conf',
      ]);
      run('/usr/bin/systemctl', ['daemon-reload']);
    },
    readCaddy: () => regular(caddyPath),
    writeCaddy: (value) => atomic(caddyPath, value),
    reloadCaddy: () => run('/usr/bin/systemctl', ['reload', 'caddy']),
    verifyStaticIdentity: (expected) => {
      if (JSON.stringify(staticIdentity()) !== JSON.stringify(expected))
        throw new Error('existing static identity changed');
    },
    enableBoot: () =>
      run('/usr/bin/systemctl', ['enable', 'ca-private-record-gateway-boot.service']),
    record(receipt) {
      atomic(ledger, JSON.stringify(receipt) + '\n', 0o600);
      if (receipt.phase !== 'requires-explicit-recovery') rmdirSync(`${root}/bootstrap.lock`);
    },
  };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0)
    throw new Error('bootstrap requires the protected Linux infrastructure provider as root');
  try {
    const source = resolve(process.argv[2] ?? '');
    const input = JSON.parse(readFileSync(0, 'utf8'));
    installBootstrap(input, productionIo(source, input));
    console.log('Gateway bootstrap committed; no gateway activated and paid source unchanged.');
  } catch {
    console.error(
      'Gateway bootstrap refused or failed; inspect its root-private operation receipt.'
    );
    process.exitCode = 1;
  }
}
