import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, '../..', path), 'utf8');
const uncommented = (source: string) =>
  source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
const job = (yaml: string, name: string) => {
  const start = yaml.indexOf(`  ${name}:`);
  expect(start, `missing job ${name}`).toBeGreaterThan(-1);
  const rest = yaml.slice(start + `  ${name}:`.length);
  const next = /^ {2}[A-Za-z0-9_-]+:\s*$/m.exec(rest);
  return yaml.slice(start, next ? start + `  ${name}:`.length + next.index : undefined);
};

const deploy = read('.github/workflows/auto-deploy-hetzner.yml');
const publish = read('.github/workflows/publish-club-arena.yml');
const publishCode = uncommented(publish);

describe('engine deployment reports what actually happened', () => {
  it('calls a release shipped only after the durable transaction and independent proof agree', () => {
    expect(deploy).toContain('[ "$UNIT_RESULT" = success ] && [ "$RESULT_SHA" = "$SHA" ]');
    expect(deploy).toContain('case "$RESULT" in sealed|already-released)');
    expect(deploy).toMatch(
      /SHIPPED: .*steps\.release\.outputs\.result == 'sealed'.*steps\.verify\.outputs\.verified == 'true'/
    );
    expect(deploy).toContain("steps.release.outputs.result || 'not completed'");
    expect(deploy).toContain("steps.verify.outputs.verified || 'false'");
    expect(deploy).toContain("STRICT_RECEIPT: '1'");
  });

  it('never represents a selectable ref or force flag as deployment authority', () => {
    const code = uncommented(deploy);
    expect(code).not.toMatch(/workflow_dispatch:|github\.event\.inputs/);
    expect(code).not.toMatch(/force=true|inputs\.force/);
    expect(code).toContain('github.event.client_payload.ref_sha');
  });
});

describe('the Club Arena bundle publishes directly to its Hetzner origin', () => {
  it('a recovery event can publish only the exact current protected-main SHA', () => {
    const resolver = publish.slice(
      publish.indexOf('- name: Resolve the tip of main'),
      publish.indexOf('- name: Has this exact tree already passed the client suite?')
    );
    expect(resolver).toContain('[ "$REQUESTED_SHA" = "$TIP" ]');
    expect(resolver).toContain('TARGET="$REQUESTED_SHA"');
    expect(resolver).not.toContain('/compare/${REQUESTED_SHA}...${TIP}');
    expect(resolver).not.toMatch(/identical\|ahead/);
  });

  it('contains no executable World Hub checkout, sync token, or Vercel deploy', () => {
    expect(publishCode).not.toMatch(/repository:\s*Smarter-Poker\/Smarter-Poker-World-Hub/);
    expect(publishCode).not.toMatch(/WORLD_HUB_(?:SYNC_)?TOKEN/);
    expect(publishCode).not.toMatch(/\bvercel\s+(?:deploy|--prod)\b/i);
    expect(publishCode).toContain('ORIGIN_URL: https://ca-static.smarter.poker');
  });

  it('uses only the Club Arena origin credential names', () => {
    const origin = job(publish, 'publish-to-origin');
    expect(origin).toContain('secrets.CA_ORIGIN_HOST');
    expect(origin).toContain('secrets.CA_ORIGIN_SSH_KEY');
    expect(origin).toContain('secrets.CA_ORIGIN_HOST_KEY');
    expect(origin).not.toMatch(/HETZNER_SSH_KEY|WORLD_HUB|VERCEL_TOKEN/);
  });

  it('runs every release job on a fresh hosted runner', () => {
    const runners = [...publish.matchAll(/^\s+runs-on:\s*(.+)$/gm)].map((match) => match[1].trim());
    expect(runners.length).toBeGreaterThanOrEqual(4);
    expect(new Set(runners)).toEqual(new Set(['ubuntu-latest']));
    expect(publish).not.toContain('vars.CI_RUNNER');
    expect(publish).not.toContain('self-hosted');
  });

  it('requires both the built artifact and the test verdict before publishing', () => {
    const origin = job(publish, 'publish-to-origin');
    expect(origin).toContain('needs: [publish-needed, build-and-store, client-tests]');
    expect(origin).toContain("needs.build-and-store.result == 'success'");
    expect(origin).toContain("needs.client-tests.result == 'success'");
  });

  it('has read-only repository authority while the origin SSH key performs the publish', () => {
    const origin = job(publish, 'publish-to-origin');
    expect(origin).toMatch(/^\s+contents:\s*read\s*$/m);
    expect(origin).not.toMatch(/^\s+(?:contents|actions):\s*write\s*$/m);
  });

  it('uploads an immutable release and swaps current only after the transfer', () => {
    const origin = job(publish, 'publish-to-origin');
    const upload = origin.indexOf('"$ORIGIN_USER@$ORIGIN_HOST:$ORIGIN_ROOT/incoming/$STAGE_NAME/"');
    const manifest = origin.indexOf(
      '(cd "$STAGE" && sha256sum --strict -c .release-manifest.sha256'
    );
    const lock = origin.indexOf('flock -w 45 9');
    const swap = origin.indexOf('mv -Tf "$NEXT" "$ROOT/current"');
    expect(upload).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(upload);
    expect(manifest).toBeGreaterThan(lock);
    expect(swap).toBeGreaterThan(manifest);
    expect(origin).not.toContain('$ORIGIN_ROOT/releases/$SHA/"');
    expect(publish).toContain('Seal the immutable release bytes');
    expect(origin).toContain('cmp -s "$STAGE/.release-manifest.sha256"');
    expect(origin).toContain('(cd "$FINAL" && sha256sum --strict -c');
  });

  it('performs the final decision as a host-locked compare-and-swap', () => {
    const origin = job(publish, 'publish-to-origin');
    const lock = origin.indexOf('flock -w 45 9');
    const readCurrent = origin.indexOf('CURRENT_SHA=$(sed', lock);
    const compare = origin.indexOf('[ "$CURRENT_SHA" != "$EXPECTED_SHA" ]', readCurrent);
    const swap = origin.indexOf('mv -Tf "$NEXT" "$ROOT/current"', compare);
    expect(lock).toBeGreaterThan(-1);
    expect(readCurrent).toBeGreaterThan(lock);
    expect(compare).toBeGreaterThan(readCurrent);
    expect(swap).toBeGreaterThan(compare);
    expect(origin).toContain('refusing stale activation');
  });

  it('flushes release bytes before activation and the symlink rename before success', () => {
    const origin = job(publish, 'publish-to-origin');
    const swap = origin.indexOf('mv -Tf "$NEXT" "$ROOT/current"');
    const flushes = [...origin.matchAll(/sync -f "\$ROOT"/g)].map((match) => match.index!);
    expect(flushes.some((index) => index < swap)).toBe(true);
    expect(flushes.some((index) => index > swap)).toBe(true);
    expect(origin).toContain('rsync -az --delete --fsync');
  });

  it('serializes the additive pool with activation and gives mutable fonts one pointer', () => {
    const origin = job(publish, 'publish-to-origin');
    const lock = origin.indexOf('flock -w 45 9');
    const pool = origin.indexOf('rsync -a --fsync "$FINAL/assets/"', lock);
    const fontPointer = origin.indexOf('ln -s "$ROOT/current/fonts/fonts.css" "$FONT_NEXT"', pool);
    const swap = origin.indexOf('mv -Tf "$NEXT" "$ROOT/current"', fontPointer);
    expect(pool).toBeGreaterThan(lock);
    expect(fontPointer).toBeGreaterThan(pool);
    expect(swap).toBeGreaterThan(fontPointer);
    expect(origin).not.toContain('dist/fonts/ "$ORIGIN_USER@$ORIGIN_HOST:$ORIGIN_ROOT/pool');
  });

  it('rejects both changed bytes and files omitted from an existing manifest', () => {
    const origin = job(publish, 'publish-to-origin');
    expect(origin).toContain('verify_complete_manifest "$STAGE"');
    expect(origin).toContain('verify_complete_manifest "$FINAL"');
    expect(origin).toContain("find . -type f ! -path './.release-manifest.sha256' -print0");
    expect(origin).toContain('cmp -s "$CHECK" "$release_dir/.release-manifest.sha256"');
  });

  it('bounds every job and every origin transport operation', () => {
    const jobTimeouts = [...publish.matchAll(/^ {4}timeout-minutes: (\d+)$/gm)].map((match) =>
      Number(match[1])
    );
    expect(jobTimeouts).toHaveLength(5);
    expect(jobTimeouts.every((minutes) => minutes > 0 && minutes <= 30)).toBe(true);
    const origin = job(publish, 'publish-to-origin');
    expect(origin).toContain('timeout 35s ssh');
    expect(origin).toContain('timeout 240s rsync');
    expect(origin).toContain('-o ServerAliveCountMax=2');
  });

  it('cleans the exact staging path and credentials on every terminal path', () => {
    const origin = job(publish, 'publish-to-origin');
    expect(origin).toContain("if: always() && steps.verdict.outputs.verdict == 'publish'");
    expect(origin).toContain('rm -rf -- "$ROOT/incoming/$STAGE_NAME"');
    expect(origin).toContain('- name: Remove origin credentials and control sockets');
    expect(origin).toMatch(
      /Remove origin credentials and control sockets[\s\S]*?if: always\(\)[\s\S]*?rm -f -- "\$HOME\/\.ssh\/ca_origin"/
    );
  });

  it('proves the exact ca_sha from the live origin before declaring success', () => {
    const origin = job(publish, 'publish-to-origin');
    expect(origin).toContain('$ORIGIN_URL/build-info.json?cb=$RANDOM');
    expect(origin).toContain('$PUBLIC_URL/build-info.json?cb=$RANDOM');
    expect(origin).toContain('[ "$LIVE_ORIGIN" = "$SHA" ]');
    expect(origin).toContain('[ "$LIVE_PUBLIC" = "$SHA" ]');
    expect(origin).toContain('echo \'verified=true\' >> "$GITHUB_OUTPUT"');
    expect(origin).toMatch(/origin serves '\$LIVE_ORIGIN'.*wanted \$SHA[\s\S]{0,80}exit 1/);
    const app = job(publish, 'publish-to-app');
    expect(app).toContain("needs.publish-to-origin.outputs.verified == 'true'");
  });
});
