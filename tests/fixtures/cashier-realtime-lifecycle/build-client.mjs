// Test-only candidate bundle. Never invokes or substitutes the production publisher.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const root = 'dist-cashier-fixture';
// Generate the same approved media variants that the maintained application build uses.
for (const script of [
  'scripts/generate-webp-media.mjs',
  'scripts/generate-customization-thumbnails.mjs',
])
  execFileSync(process.execPath, [script], { stdio: 'inherit' });
execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', root], {
  stdio: 'inherit',
  env: {
    ...process.env,
    VITE_SUPABASE_URL: 'https://kuklfnapbkmacvwxktbh.supabase.co',
    VITE_SUPABASE_ANON_KEY: 'sb_publishable_cashier_native_fixture_routing_only',
  },
});
writeFileSync(
  path.join(root, 'build-info.json'),
  JSON.stringify({
    ca_sha: sha,
    run_id: process.env.GITHUB_RUN_ID || 'local',
    built_by: 'cashier-native-fixture',
  })
);
function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw Error('Symlink in fixture build');
    return stat.isDirectory() ? files(full) : [full];
  });
}
writeFileSync(
  path.join(root, '.release-manifest.sha256'),
  files(root)
    .sort()
    .map(
      (file) =>
        createHash('sha256').update(readFileSync(file)).digest('hex') +
        '  ' +
        path.relative(root, file)
    )
    .join('\n') + '\n'
);
