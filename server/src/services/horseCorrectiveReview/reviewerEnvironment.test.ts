import { describe, expect, it } from 'vitest';
import { correctiveReviewerChildEnvironment } from './reviewerEnvironment.js';
describe('qualification child credential isolation', () => {
  const input = {
    PATH: '/configured/bin',
    HOME: '/configured/home',
    TMPDIR: '/configured/scratch',
    LANG: 'C',
    GH_TOKEN: 'configured-github-auth',
    DATABASE_URL: 'private-db',
    HORSE_PHASE14_QUALIFICATION_SIGNING_KEY: 'private-purpose-key',
    HETZNER_SSH_PRIVATE_KEY: 'private-host-key',
    NODE_OPTIONS: '--require=untrusted',
  };
  it('gives local Git only explicit path/locale configuration', () => {
    expect(correctiveReviewerChildEnvironment('git', input)).toEqual({
      PATH: input.PATH,
      HOME: input.HOME,
      TMPDIR: input.TMPDIR,
      LANG: 'C',
    });
  });
  it('gives GitHub metadata only configured GitHub authentication, excluding signer/database/host keys', () => {
    expect(correctiveReviewerChildEnvironment('github', input)).toEqual({
      PATH: input.PATH,
      HOME: input.HOME,
      TMPDIR: input.TMPDIR,
      LANG: 'C',
      GH_TOKEN: input.GH_TOKEN,
    });
    expect(input.HORSE_PHASE14_QUALIFICATION_SIGNING_KEY).toBe('private-purpose-key');
  });
});
