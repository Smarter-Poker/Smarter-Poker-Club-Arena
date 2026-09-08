import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = resolve(process.cwd(), 'server/scripts/install-caddy-websocket-log-redaction.sh');
const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

function fixture(liveConfig: string) {
  const workspace = mkdtempSync(join(tmpdir(), 'caddy-redaction-installer-'));
  workspaces.push(workspace);
  const bin = join(workspace, 'bin');
  mkdirSync(bin);
  const caddyfile = join(workspace, 'Caddyfile');
  const calls = join(workspace, 'systemctl.calls');
  const reloadFailed = join(workspace, 'reload.failed.once');
  const inactiveFailed = join(workspace, 'inactive.failed.once');
  const caddy = join(bin, 'caddy');
  const systemctl = join(bin, 'systemctl');
  const flock = join(bin, 'flock');
  writeFileSync(caddyfile, liveConfig);
  writeFileSync(
    caddy,
    `#!/bin/sh
if [ "\${FAKE_CADDY_VALIDATE_FAIL:-0}" = "1" ]; then exit 1; fi
exit 0
`
  );
  writeFileSync(
    systemctl,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SYSTEMCTL_CALLS"
if [ "$1" = "reload" ] && [ "\${FAKE_RELOAD_FAIL_ONCE:-0}" = "1" ] && [ ! -f "$FAKE_RELOAD_FAILED_FILE" ]; then
  : > "$FAKE_RELOAD_FAILED_FILE"
  exit 1
fi
if [ "$1" = "is-active" ] && [ "\${FAKE_INACTIVE_ONCE:-0}" = "1" ] && [ ! -f "$FAKE_INACTIVE_FAILED_FILE" ]; then
  : > "$FAKE_INACTIVE_FAILED_FILE"
  exit 1
fi
exit 0
`
  );
  writeFileSync(flock, '#!/bin/sh\nexit 0\n');
  chmodSync(caddy, 0o755);
  chmodSync(systemctl, 0o755);
  chmodSync(flock, 0o755);

  const run = (extraEnv: Record<string, string> = {}) =>
    spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CADDY_INSTALL_ALLOW_NON_ROOT: '1',
        CADDYFILE: caddyfile,
        CADDY_BIN: caddy,
        SYSTEMCTL_BIN: systemctl,
        PYTHON_BIN: 'python3',
        FLOCK_BIN: flock,
        CADDY_REDACTION_LOCK_FILE: join(workspace, 'installer.lock'),
        FAKE_SYSTEMCTL_CALLS: calls,
        FAKE_RELOAD_FAILED_FILE: reloadFailed,
        FAKE_INACTIVE_FAILED_FILE: inactiveFailed,
        ...extraEnv,
      },
    });

  return { workspace, caddyfile, calls, run };
}

const OPERATOR_HASH = '$2a$14$operatorManagedHashMustSurviveExactly';
const LIVE_CONFIG = `engine.smarter.poker {
    handle_path /prometheus/* {
        basic_auth {
            monitor ${OPERATOR_HASH}
        }
        reverse_proxy 127.0.0.1:9090
    }
    reverse_proxy 127.0.0.1:8080
}
`;

describe('Caddy WebSocket credential-log redaction installer', () => {
  it('preserves the live hash/routes and is a validated idempotent no-op on rerun', () => {
    const f = fixture(LIVE_CONFIG);
    const first = f.run();
    expect(first.status, first.stderr || first.stdout).toBe(0);
    expect(`${first.stdout}\n${first.stderr}`).not.toContain(OPERATOR_HASH);

    const installed = readFileSync(f.caddyfile, 'utf8');
    expect(installed).toContain(OPERATOR_HASH);
    expect(installed).toContain('handle_path /prometheus/*');
    expect(installed).toContain('reverse_proxy 127.0.0.1:8080');
    expect(installed.match(/request>headers>Sec-Websocket-Protocol delete/g)).toHaveLength(1);

    const backupsAfterFirst = readdirSync(f.workspace).filter((name) =>
      name.startsWith('Caddyfile.pre-websocket-redaction.')
    );
    expect(backupsAfterFirst).toHaveLength(1);
    expect(readFileSync(join(f.workspace, backupsAfterFirst[0]), 'utf8')).toBe(LIVE_CONFIG);

    const second = f.run();
    expect(second.status, second.stderr || second.stdout).toBe(0);
    expect(readFileSync(f.caddyfile, 'utf8')).toBe(installed);
    expect(
      readdirSync(f.workspace).filter((name) =>
        name.startsWith('Caddyfile.pre-websocket-redaction.')
      )
    ).toHaveLength(1);
    expect(readFileSync(f.calls, 'utf8').trim().split('\n')).toEqual([
      'reload caddy',
      'is-active --quiet caddy',
      'reload caddy',
      'is-active --quiet caddy',
    ]);
  });

  it('never touches the live file when candidate validation fails', () => {
    const f = fixture(LIVE_CONFIG);
    const result = f.run({ FAKE_CADDY_VALIDATE_FAIL: '1' });
    expect(result.status).toBe(1);
    expect(readFileSync(f.caddyfile, 'utf8')).toBe(LIVE_CONFIG);
    expect(
      readdirSync(f.workspace).some((name) => name.includes('.pre-websocket-redaction.'))
    ).toBe(false);
    expect(readdirSync(f.workspace)).not.toContain('systemctl.calls');
  });

  it('never reloads a monitoring password placeholder during bootstrap', () => {
    const placeholder = LIVE_CONFIG.replace(
      OPERATOR_HASH,
      '$2a$14$REPLACE_WITH_CADDY_HASH_PASSWORD_OUTPUT'
    );
    const f = fixture(placeholder);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(readFileSync(f.caddyfile, 'utf8')).toBe(placeholder);
    expect(readdirSync(f.workspace)).not.toContain('systemctl.calls');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(OPERATOR_HASH);
  });

  it('restores and reloads the exact previous file when the new reload fails', () => {
    const f = fixture(LIVE_CONFIG);
    const result = f.run({ FAKE_RELOAD_FAIL_ONCE: '1' });
    expect(result.status).toBe(1);
    expect(readFileSync(f.caddyfile, 'utf8')).toBe(LIVE_CONFIG);
    expect(readFileSync(f.calls, 'utf8').trim().split('\n')).toEqual([
      'reload caddy',
      'reload caddy',
      'is-active --quiet caddy',
    ]);
  });

  it('restores the exact previous file when Caddy is inactive after reload', () => {
    const f = fixture(LIVE_CONFIG);
    const result = f.run({ FAKE_INACTIVE_ONCE: '1' });
    expect(result.status).toBe(1);
    expect(readFileSync(f.caddyfile, 'utf8')).toBe(LIVE_CONFIG);
    expect(readFileSync(f.calls, 'utf8').trim().split('\n')).toEqual([
      'reload caddy',
      'is-active --quiet caddy',
      'reload caddy',
      'is-active --quiet caddy',
    ]);
  });

  it('adds the logger inside an existing global options block', () => {
    const existingGlobal = `{\n    admin off\n}\n\n${LIVE_CONFIG}`;
    const f = fixture(existingGlobal);
    const result = f.run();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const installed = readFileSync(f.caddyfile, 'utf8');
    expect(installed).toContain(OPERATOR_HASH);
    expect(installed.indexOf('request>headers>Sec-Websocket-Protocol delete')).toBeLessThan(
      installed.indexOf('\n}')
    );
  });
});

describe('the monitoring deploy actually invokes the safe installer', () => {
  it('ships the installer, triggers when it changes, and invokes it after preserving Caddy', () => {
    const workflow = readFileSync(
      resolve(process.cwd(), '.github/workflows/deploy-monitoring.yml'),
      'utf8'
    );
    const deploy = readFileSync(resolve(process.cwd(), 'infra/monitoring/deploy.sh'), 'utf8');
    expect(workflow).toContain("- 'server/scripts/install-caddy-websocket-log-redaction.sh'");
    expect(workflow).toContain(
      'tar -C . -cf - infra/monitoring server/scripts/install-caddy-websocket-log-redaction.sh'
    );
    expect(workflow).toContain(
      'chmod +x /opt/smarter-poker-monitoring-src/server/scripts/install-caddy-websocket-log-redaction.sh'
    );
    expect(deploy).toContain(
      'CADDY_REDACTION_INSTALLER="$SRC_DIR/server/scripts/install-caddy-websocket-log-redaction.sh"'
    );
    expect(deploy.indexOf('"$CADDY_REDACTION_INSTALLER"')).toBeGreaterThan(
      deploy.indexOf('NEVER PUT A PLACEHOLDER OVER A LIVE PASSWORD')
    );
  });
});
