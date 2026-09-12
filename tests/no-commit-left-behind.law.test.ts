import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');
const uncommented = (source: string) =>
  source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
const triggers = (yaml: string) =>
  yaml.slice(yaml.indexOf('\non:'), yaml.indexOf('\nconcurrency:'));

const publisher = read('.github/workflows/publish-club-arena.yml');
const publisherCode = uncommented(publisher);
const target = '${{ needs.publish-needed.outputs.target_sha }}';

describe('no commit left behind means exact, fail-closed release events', () => {
  it('resolves one full current-main SHA and exposes it to every release job', () => {
    expect(publisher).toContain('target_sha: ${{ steps.target.outputs.sha }}');
    expect(publisherCode).toMatch(/gh api "repos\/\$\{\{ github\.repository \}\}\/commits\/main"/);
    expect(publisherCode).toMatch(/\[\[ "\$TIP" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
    expect(publisherCode).toContain(
      'Could not resolve one full current-main SHA; refusing to publish.'
    );
    expect(publisherCode).not.toContain('TIP="${{ github.sha }}"');
  });

  it('requires an exact ref_sha and proves it belongs to current main', () => {
    expect(publisherCode).toContain(
      "REQUESTED_SHA: ${{ github.event.client_payload.ref_sha || '' }}"
    );
    expect(publisherCode).toMatch(/\[\[ "\$REQUESTED_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
    expect(publisherCode).toContain('[ "$REQUESTED_SHA" = "$TIP" ]');
    expect(publisherCode).toContain('TARGET="$REQUESTED_SHA"');
    expect(publisherCode).not.toContain('compare/${REQUESTED_SHA}...${TIP}');
  });

  it('checks out, stamps, and transports the same immutable target', () => {
    const checkoutBlocks = [
      ...publisher.matchAll(/uses: actions\/checkout@v4\n((?:\s{8,}.*\n)*)/g),
    ].map((match) => match[1]);
    expect(checkoutBlocks.length).toBeGreaterThanOrEqual(2);
    const controls = checkoutBlocks.filter((block) => /^\s+path: control$/m.test(block));
    expect(controls).toHaveLength(2);
    for (const block of checkoutBlocks) {
      expect(block).toContain(`ref: ${controls.includes(block) ? '${{ github.sha }}' : target}`);
      if (controls.includes(block)) expect(block).toContain('persist-credentials: false');
    }

    expect(publisher).toContain(`"ca_sha": "${target}"`);
    expect(publisher).toContain(`VITE_APP_VERSION: ${target}`);
    expect(publisher).toContain(`name: club-arena-dist-${target}`);
  });

  it('fails closed when origin provenance or ancestry cannot be ordered', () => {
    expect(publisherCode).toContain(
      'Origin provenance is unreadable; refusing an unorderable publish.'
    );
    expect(publisherCode).toContain('Cannot prove the candidate is a forward Club Arena release');
    expect(publisherCode).toMatch(/ahead\) VERDICT=publish/);
    expect(publisherCode).toMatch(/behind\) VERDICT=standdown/);
  });
});

describe('one event creates one publish attempt', () => {
  it('uses push or an exact repository event, never timers or branch-authored dispatch', () => {
    const on = triggers(publisher);
    expect(on).toMatch(/^\s{2}push:/m);
    expect(on).toMatch(/^\s{2}repository_dispatch:/m);
    expect(on).toContain('types: [publish-club-arena]');
    expect(on).not.toMatch(/^\s{2}schedule:/m);
    expect(on).not.toMatch(/^\s{2}workflow_dispatch:/m);
  });

  it('has no self-chain and no watchdog retry path', () => {
    expect(publisherCode).not.toMatch(/Converge - chain another publish/);
    expect(publisherCode).not.toMatch(/repos\/\$\{\{ github\.repository \}\}\/dispatches/);
    expect(existsSync(resolve(__dirname, '../.github/scripts/publish-watchdog.sh'))).toBe(false);
    expect(existsSync(resolve(__dirname, '../.github/scripts/engine-watchdog.sh'))).toBe(false);
    expect(existsSync(resolve(__dirname, '../.github/workflows/publish-watchdog.yml'))).toBe(false);
  });

  it('keeps one non-cancelling publisher', () => {
    expect(publisherCode).toMatch(
      /concurrency:\s*\n\s*group: publish-club-arena-production\n\s*queue: max\n\s*cancel-in-progress: false/
    );
    const publishers = readdirSync(resolve(__dirname, '../.github/workflows')).filter((file) => {
      if (!/\.ya?ml$/.test(file)) return false;
      return /^ {2}publish-to-origin:/m.test(read(`.github/workflows/${file}`));
    });
    expect(publishers).toEqual(['publish-club-arena.yml']);
  });
});

describe('release suppression has no local escape hatch', () => {
  it('the commit-message guard fails closed and remains in pre-push', () => {
    const guard = read('scripts/ci/check-no-skip-markers.mjs');
    const hook = read('.husky/pre-push');
    expect(hook).toContain('scripts/ci/check-no-skip-markers.mjs');
    expect(guard).toContain('process.exit(1)');
    expect(guard).not.toContain('CA_ALLOW_SKIP_MARKER');
    expect(guard).not.toMatch(/could not read[\s\S]{0,120}process\.exit\(0\)/i);
  });
});
