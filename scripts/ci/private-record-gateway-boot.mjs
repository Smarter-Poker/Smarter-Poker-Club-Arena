/** Recreates only the already-committed service on host boot. Never selects a release. */
import { readFileSync, lstatSync, mkdirSync, symlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyGatewayArtifact } from './private-record-gateway-artifact.mjs';
if (process.getuid?.() !== 0) throw new Error('host boot entry must run as root');
const root = '/srv/ca-private-record-gateway',
  runtime = '/run/ca-private-record-gateway';
for (const directory of [root, join(root, 'releases')]) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0)
    throw new Error('untrusted gateway release root');
}
const recordPath = join(root, 'active-release.json');
const stat = lstatSync(recordPath);
if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0)
  throw new Error('untrusted committed release record');
const record = JSON.parse(readFileSync(recordPath, 'utf8'));
if (record.state !== 'verified' || !/^[0-9a-f]{40}$/.test(record.revision))
  throw new Error('no committed verified gateway revision');
const release = join(root, 'releases', record.revision);
const releaseStat = lstatSync(release);
if (!releaseStat.isDirectory() || releaseStat.uid !== 0 || (releaseStat.mode & 0o022) !== 0)
  throw new Error('untrusted committed release directory');
verifyGatewayArtifact(release, record.revision);
mkdirSync(runtime, { recursive: true, mode: 0o755 });
const parent = lstatSync(runtime);
if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) !== 0)
  throw new Error('untrusted runtime parent');
mkdirSync(join(runtime, record.revision), { recursive: true, mode: 0o750 });
if (!lstatSync(join(runtime, record.revision)).isDirectory())
  throw new Error('gateway runtime revision must be a real directory');
execFileSync('/usr/bin/chown', ['ca-record-gateway:caddy', join(runtime, record.revision)], {
  timeout: 5000,
});
const temporary = join(runtime, `.boot.${process.pid}.sock`);
symlinkSync(`${record.revision}/listener.sock`, temporary);
renameSync(temporary, join(runtime, 'active.sock'));
execFileSync(
  '/usr/bin/systemctl',
  ['start', `ca-private-record-gateway@${record.revision}.service`],
  { stdio: 'inherit', timeout: 30000 }
);
