import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { gatewayMachineIdSha256 } from './source/scripts/ci/private-record-gateway-host-identity.mjs';
const scenario = process.argv[2];
assert.ok(['success', 'caddy-drift', 'same-host', 'rollback'].includes(scenario));
const run = (file, args, options = {}) =>
  execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
const root = '/qualification/source';
const sha = 'a'.repeat(40);
const global = '{\n auto_https off\n admin 127.0.0.1:2019\n}\n';
const site = (identity, gateway = false) =>
  `http://ca-static.smarter.poker:8080 {\n${gateway ? 'handle_path /private-record/* {\n reverse_proxy unix//run/ca-private-record-gateway/active.sock\n}\n' : ''}handle {\nrespond /build-info.json "{\\"ca_sha\\":\\"${identity}\\"}" 200\nrespond "original static" 200\n}\n}\nhttp://unrelated.example:8080 {\nrespond "unrelated retained" 200\n}\n`;
const before = global + site(sha);
const replacement = global + site(scenario === 'rollback' ? 'b'.repeat(40) : sha, true);
mkdirSync('/etc/caddy', { recursive: true });
writeFileSync('/etc/caddy/Caddyfile', before);
writeFileSync(
  root + '/infra/ca-origin/private-record-gateway.caddy-preimage',
  scenario === 'caddy-drift' ? before + '# reviewed different predecessor\n' : before
);
writeFileSync(root + '/infra/ca-origin/Caddyfile', replacement);
writeFileSync('/etc/machine-id', '8de277067b3544d4b65c267d0edab928\n');
run('/usr/sbin/groupadd', ['--system', 'caddy']);
run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', '/qualification/synthetic-key']);
// Caddy runs for real. Only the service-manager adapter is explicit because
// this disposable container has no systemd PID1; validate/enable use real tools.
renameSync('/usr/bin/systemctl', '/usr/bin/systemctl.real');
writeFileSync(
  '/usr/bin/systemctl',
  `#!/bin/sh\nset -eu\nprintf '%s\\n' "$*" >> /qualification/systemctl.log\ncase "$*" in\n 'reload caddy') exec /usr/bin/caddy reload --config /etc/caddy/Caddyfile;;\n 'daemon-reload') exec /usr/bin/systemd-analyze verify /etc/systemd/system/ca-private-record-gateway@.service /etc/systemd/system/ca-private-record-gateway-boot.service;;\n 'enable ca-private-record-gateway-boot.service') exec /usr/bin/systemctl.real "$@";;\n *) echo 'Unexpected service operation' >&2; exit 1;;\nesac\n`,
  { mode: 0o755 }
);
renameSync('/usr/bin/curl', '/usr/bin/curl.real');
// Both immutable production URL constants are redirected inside this network-none
// container to real HTTP responses. No production credential or network is used.
writeFileSync(
  '/usr/bin/curl',
  `#!/bin/sh\nset -eu\nfor arg do target="$arg"; done\ncase "$target" in\n https://ca-static.smarter.poker/build-info.json|https://smarter.poker/hub/club-arena/build-info.json) exec /usr/bin/curl.real --fail --silent --show-error --max-time 5 -H 'Host: ca-static.smarter.poker' http://127.0.0.1:8080/build-info.json;;\n *) echo 'External network refused' >&2; exit 1;;\nesac\n`,
  { mode: 0o755 }
);
// Parse both exact configurations before starting the real server. A grammar error
// must fail directly rather than masquerade as an HTTP readiness timeout.
for (const configuration of [before, replacement])
  run('/usr/bin/caddy', ['adapt', '--config', '-', '--adapter', 'caddyfile'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    input: configuration,
  });
const server = spawn('/usr/bin/caddy', ['run', '--config', '/etc/caddy/Caddyfile'], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
let caddyError = '';
server.stderr.on('data', (chunk) => {
  caddyError += chunk.toString();
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      run('/usr/bin/curl', ['https://ca-static.smarter.poker/build-info.json']);
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(ready, 'isolated Caddy failed to start: ' + caddyError);
  const input = {
    revision: sha,
    runId: '9001',
    engineMachineIdSha256:
      scenario === 'same-host'
        ? gatewayMachineIdSha256(readFileSync('/etc/machine-id'))
        : 'b'.repeat(64),
    publisherPublicKey: readFileSync('/qualification/synthetic-key.pub', 'utf8').trim(),
    trustedRoot: '{"fixture":"root-metadata"}\n',
    environment: {
      PRIVATE_RECORD_GATEWAY_DATABASE_URL:
        'postgresql://ca_record_gateway:synthetic@db.invalid:5432/postgres',
      SUPABASE_URL: 'https://kuklfnapbkmacvwxktbh.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'isolated-fixture-only',
    },
  };
  let succeeded = true;
  try {
    run('/usr/bin/node', [root + '/scripts/ci/private-record-gateway-bootstrap.mjs', root], {
      input: JSON.stringify(input),
    });
  } catch {
    succeeded = false;
  }
  assert.equal(succeeded, scenario === 'success');
  if (scenario === 'success') {
    assert.equal(
      JSON.parse(readFileSync('/srv/ca-private-record-gateway/bootstrap-9001.json')).phase,
      'committed'
    );
    run('/usr/bin/id', ['ca-record-publisher']);
    run('/usr/bin/id', ['ca-record-gateway']);
    for (const path of [
      '/etc/club-arena/private-record-gateway.env',
      '/etc/club-arena/github-actions-trusted-root.jsonl',
    ]) {
      const stat = statSync(path);
      assert.equal(stat.uid, 0);
      assert.equal(stat.mode & 0o777, 0o600);
    }
    for (const path of [
      '/etc/club-arena/private-record-gateway.env',
      '/usr/local/libexec/ca-private-record-gateway-activate',
      '/srv/ca-private-record-gateway/releases',
    ]) {
      assert.throws(() =>
        run('/usr/sbin/runuser', [
          '-u',
          'ca-record-publisher',
          '--',
          '/bin/sh',
          '-c',
          `test -w '${path}'`,
        ])
      );
    }
    assert.throws(() =>
      run('/usr/sbin/runuser', [
        '-u',
        'ca-record-publisher',
        '--',
        '/usr/bin/sudo',
        '-n',
        '/bin/true',
      ])
    );
    assert.ok(
      existsSync(
        '/etc/systemd/system/multi-user.target.wants/ca-private-record-gateway-boot.service'
      )
    );
  } else if (scenario === 'rollback') {
    assert.equal(readFileSync('/etc/caddy/Caddyfile', 'utf8'), before);
    assert.equal(
      JSON.parse(readFileSync('/srv/ca-private-record-gateway/bootstrap-9001.json')).phase,
      'failed-inert'
    );
  } else {
    assert.equal(readFileSync('/etc/caddy/Caddyfile', 'utf8'), before);
    assert.throws(() => run('/usr/bin/id', ['ca-record-publisher']));
  }
  assert.equal(
    run('/usr/bin/curl.real', [
      '--fail',
      '--silent',
      '--header',
      'Host: unrelated.example',
      'http://127.0.0.1:8080/',
    ]),
    'unrelated retained'
  );
  assert.equal(
    JSON.parse(run('/usr/bin/curl', ['https://ca-static.smarter.poker/build-info.json'])).ca_sha,
    sha
  );
  assert.ok(!existsSync('/run/ca-private-record-gateway/active.sock'));
  assert.ok(!existsSync('/srv/ca-private-record-gateway/active-release.json'));
  const operations = existsSync('/qualification/systemctl.log')
    ? readFileSync('/qualification/systemctl.log', 'utf8')
    : '';
  assert.doesNotMatch(operations, /^start |^restart /m);
  console.log(
    `LINUX_BOOTSTRAP ${scenario} PASS: real filesystem/users/Caddy; no gateway activation`
  );
} finally {
  server.kill('SIGTERM');
}
