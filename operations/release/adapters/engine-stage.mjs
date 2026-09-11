import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

const need = (v) => { if (!v) throw new Error('RELEASE_ENGINE_STAGE_CONTRACT_REFUSED'); };
export function artifactDownload(token, repo, fetcher = fetch) {
  need(typeof token === 'string' && token.length > 0 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo));
  return async function* (r) {
    need(/^[1-9][0-9]*$/.test(r.github_artifact_id));
    const response = await fetcher(`https://api.github.com/repos/${repo}/actions/artifacts/${r.github_artifact_id}/zip`, {
      redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
    });
    need(response.status === 302);
    const location = new URL(response.headers.get('location'));
    need(location.protocol === 'https:' && !location.username && !location.password &&
      (location.hostname.endsWith('.blob.core.windows.net') || location.hostname.endsWith('.actions.githubusercontent.com')));
    const download = await fetcher(location, { redirect: 'error', signal: AbortSignal.timeout(900000) });
    need(download.ok);
    let bytes = 0; const hash = createHash('sha256');
    for await (const chunk of download.body) {
      bytes += chunk.length; need(bytes <= r.github_archive_bytes); hash.update(chunk); yield chunk;
    }
    need(bytes === r.github_archive_bytes && `sha256:${hash.digest('hex')}` === r.github_archive_digest);
  };
}

export function stageTransport(hostAlias, download, spawnChild = spawn) {
  need(/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(hostAlias));
  return async (action, envelope) => {
    need(['current', 'preflight', 'receive', 'observe'].includes(action));
    const child = spawnChild('/usr/bin/ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ConnectTimeout=10', hostAlias,
      `/usr/local/lib/club-arena-release-controller/engine-stage-boundary.py ${action}`],
      { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), action === 'receive' ? 960000 : 60000);
    let output = '', bytes = 0;
    const completion = new Promise((resolve, reject) => {
      child.on('error', () => reject(new Error('RELEASE_STAGE_TRANSPORT_FAILED')));
      child.stdout.on('data', (chunk) => { bytes += chunk.length;
        if (bytes > 65536) { child.kill('SIGTERM'); reject(new Error('RELEASE_STAGE_OUTPUT_LIMIT')); }
        else output += chunk.toString();
      });
      child.stderr.resume();
      child.on('close', (code) => {
        try { need(code === 0); resolve(JSON.parse(output)); } catch { reject(new Error('RELEASE_STAGE_READBACK_UNRESOLVED')); }
      });
    });
    // Observe rejection immediately while transfer awaits network backpressure.
    completion.catch(() => {});
    child.stdin.on('error', () => {});
    try {
      child.stdin.write(JSON.stringify(envelope) + '\n');
      if (action === 'receive') {
        for await (const chunk of download(envelope.request)) {
          need(!child.stdin.destroyed);
          if (!child.stdin.write(chunk)) await once(child.stdin, 'drain');
        }
      }
      child.stdin.end();
      return await completion;
    } catch (error) { child.kill('SIGTERM'); throw error; }
    finally { clearTimeout(timer); }
  };
}

export class EngineStageAdapter {
  constructor({ controlSha, request, github, repo }) {
    need(/^[0-9a-f]{40}$/.test(controlSha));
    Object.assign(this, { controlSha, request, github, repo });
  }
  validate(r) {
    need(r?.target === 'club-arena-engine' && r.control_sha === this.controlSha &&
      ['source_sha', 'server_tree_sha'].every((k) => /^[0-9a-f]{40}$/.test(r[k])) &&
      ['archive_digest', 'github_archive_digest', 'artifact_image_id'].every((k) => /^sha256:[0-9a-f]{64}$/.test(r[k])) &&
      /^[0-9a-f]{64}$/.test(r.manifest_digest) && /^[1-9][0-9]*-1$/.test(r.run_key) &&
      /^[0-9a-f-]{36}$/.test(r.build_operation_id) && /^[1-9][0-9]*$/.test(r.github_artifact_id) &&
      ['archive_bytes', 'github_archive_bytes'].every((k) => Number.isSafeInteger(r[k]) && r[k] > 0 && r[k] <= 3 * 1024**3));
  }
  payload(r, operation) { return { request: r, operation_id: operation.id, epoch: operation.epoch }; }
  async current(r, operation) {
    this.validate(r); const result = await this.request('current', this.payload(r, operation));
    need(/^[0-9a-f]{40}$/.test(result.source_sha) && /^sha256:[0-9a-f]{64}$/.test(result.image_id));
    return { source_sha: result.source_sha, image_id: result.image_id };
  }
  async preflight(r, operation) {
    this.validate(r);
    const artifact = await this.github(`/repos/${this.repo}/actions/artifacts/${r.github_artifact_id}`);
    need(String(artifact.id) === r.github_artifact_id && !artifact.expired && artifact.digest === r.github_archive_digest &&
      artifact.size_in_bytes === r.github_archive_bytes && String(artifact.workflow_run?.id) === r.build_run_id);
    const result = await this.request('preflight', this.payload(r, operation));
    need(result.ready === true && result.source_sha === r.expected_current.source_sha && result.image_id === r.expected_current.image_id);
    return { ready: true, github_artifact_id: r.github_artifact_id, archive_digest: r.archive_digest };
  }
  async submit(r, operation) {
    await this.request('receive', this.payload(r, operation));
    return { terminal: false, reason: 'NATIVE_STAGE_ACCEPTANCE_REQUIRES_TERMINAL_READBACK' };
  }
  async reconcile(r, operation) {
    this.validate(r); const result = await this.request('observe', this.payload(r, operation));
    if (result.terminal !== true) return { terminal: false, reason: 'NATIVE_STAGE_UNRESOLVED' };
    need(result.operation_id === operation.id && result.source_sha === r.source_sha && result.control_sha === r.control_sha &&
      result.run_key === r.run_key && result.image_id === r.artifact_image_id && result.archive_digest === r.archive_digest &&
      ['SUCCEEDED', 'FAILED'].includes(result.outcome));
    return { terminal: true, outcome: result.outcome, source_sha: r.source_sha, control_sha: r.control_sha,
      run_key: r.run_key, artifact_image_id: r.artifact_image_id, archive_digest: r.archive_digest };
  }
}
