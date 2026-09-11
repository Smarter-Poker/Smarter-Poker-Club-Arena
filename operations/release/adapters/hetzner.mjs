import { spawn } from 'node:child_process';

const need = (value) => {
  if (!value) throw new Error('RELEASE_ENGINE_BOUNDARY_REFUSED');
};
const sha = /^[a-f0-9]{40}$/;
// The SSH identity/forced command and host key are installed separately. No
// accepting new keys, inline key material, candidate shell, or host override.
export function engineTransport(hostAlias, spawnChild = spawn, protocol = 1) {
  need(/^[a-zA-Z][a-zA-Z0-9-]{0,62}$/.test(hostAlias));
  need([1,2].includes(protocol));
  return (action, payload) =>
    new Promise((resolve, reject) => {
      need(['preflight', 'submit', 'observe', 'maintenance-need', 'maintenance-safe-resume'].includes(action) ||
        (protocol === 2 && action === 'resume-acceptance'));
      const child = spawnChild(
        '/usr/bin/ssh',
        [
          '-T',
          '-o',
          'BatchMode=yes',
          '-o',
          'StrictHostKeyChecking=yes',
          '-o',
          'ConnectTimeout=10',
          hostAlias,
          `/usr/local/lib/club-arena-release-controller/${protocol===2?'engine-intake-v2.py':'engine-boundary.py'} ${action}`,
        ],
        { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      let output = '';
      let size = 0;
      let done = false;
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(new Error('RELEASE_ENGINE_TRANSPORT_TIMEOUT'));
      }, 60000);
      function finish(error, result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(result);
      }
      child.on('error', () => finish(new Error('RELEASE_ENGINE_TRANSPORT_FAILED')));
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > 65536) {
          child.kill('SIGTERM');
          finish(new Error('RELEASE_ENGINE_OUTPUT_LIMIT'));
        } else output += chunk.toString('utf8');
      });
      child.stderr.resume(); // Host command logs are never copied into receipts.
      child.stdin.on('error', () => {});
      child.on('close', (code) => {
        try {
          need(code === 0);
          finish(null, JSON.parse(output));
        } catch {
          finish(new Error('RELEASE_ENGINE_READBACK_INVALID'));
        }
      });
      child.stdin.end(JSON.stringify(payload));
    });
}

export class HetznerIntakeAdapter {
  constructor({ controlSha, request }) {
    need(sha.test(controlSha));
    Object.assign(this, { controlSha, request });
  }
  validate(r) {
    need(
      r?.target === 'club-arena-engine' &&
        sha.test(r.source_sha) &&
        r.control_sha === this.controlSha
    );
    need(/^[a-f0-9]{64}$/.test(r.manifest_digest) && /^[1-9][0-9]*-[1-9][0-9]*$/.test(r.run_key));
    need(
      sha.test(r.expected_current?.source_sha) &&
        /^sha256:[a-f0-9]{64}$/.test(r.expected_current?.image_id)
    );
    need(/^sha256:[a-f0-9]{64}$/.test(r.artifact_image_id) && sha.test(r.server_tree_sha));
    need(Number.isSafeInteger(r.not_after_epoch) && r.not_after_epoch > 0);
    need(typeof r.actor === 'string' && /^[\x20-\x7e]{1,128}$/.test(r.actor));
  }
  payload(r, operation) {
    this.validate(r);
    need(/^[a-f0-9-]{36}$/.test(operation?.id) && /^[a-f0-9-]{36}$/.test(operation?.epoch));
    return { operation_id: operation.id, epoch: operation.epoch, request: r };
  }
  async preflight(r, operation) {
    const value = await this.request('preflight', this.payload(r, operation));
    need(
      value.ready === true &&
        value.source_sha === r.expected_current.source_sha &&
        value.image_id === r.expected_current.image_id
    );
    return {
      provider: 'hetzner-engine',
      ready: true,
      source_sha: value.source_sha,
      image_id: value.image_id,
      run_key: r.run_key,
    };
  }
  async submit(r, operation) {
    await this.request('submit', this.payload(r, operation));
    return {
      terminal: false,
      provider: 'hetzner-engine',
      run_key: r.run_key,
      reason: 'DURABLE_INTAKE_REQUIRES_TERMINAL_ATTESTATION',
    };
  }
  async reconcile(r, operation) {
    const value = await this.request('observe', this.payload(r, operation));
    need(
      value.operation_id === operation.id &&
        value.run_key === r.run_key &&
        value.source_sha === r.source_sha &&
        value.control_sha === r.control_sha
    );
    if (value.terminal !== true && value.acceptance_state === 'PARTIAL') {
      // Resume only a host-attested existing immutable pin. This cannot create
      // an absent request, rearm a terminal operation or grant another trial.
      const resumed = await this.request('resume-acceptance', this.payload(r, operation));
      need(resumed.accepted === true && resumed.requires_readback === true);
      return { terminal: false, provider: 'hetzner-engine', run_key: r.run_key,
        reason: 'EXISTING_NATIVE_ACCEPTANCE_RESUMED_REQUIRES_TERMINAL_ATTESTATION' };
    }
    if (value.terminal !== true)
      return {
        terminal: false,
        provider: 'hetzner-engine',
        run_key: r.run_key,
        reason: 'ENGINE_RESULT_UNRESOLVED',
      };
    need(['SUCCEEDED', 'FAILED'].includes(value.outcome));
    need(/^sha256:[a-f0-9]{64}$/.test(value.image_id));
    if (value.outcome === 'SUCCEEDED')
      need(
        ['sealed', 'already-released'].includes(value.result) &&
          value.image_id === r.artifact_image_id
      );
    else need(sha.test(value.recovered_sha));
    return {
      terminal: true,
      outcome: value.outcome,
      provider: 'hetzner-engine',
      run_key: r.run_key,
      source_sha: r.source_sha,
      control_sha: r.control_sha,
      image_id: value.image_id,
      ...(value.outcome === 'SUCCEEDED'
        ? { result: value.result }
        : { recovered_sha: value.recovered_sha }),
    };
  }
}
