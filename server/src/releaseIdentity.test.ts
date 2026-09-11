import { describe, expect, it } from 'vitest';

import { resolveReleaseIdentity } from './releaseIdentity.js';

describe('resolveReleaseIdentity', () => {
  it('publishes both compatible short copy and an exact immutable SHA', () => {
    const sha = 'a1'.repeat(20);
    expect(resolveReleaseIdentity({ GIT_COMMIT_SHA: sha.toUpperCase() })).toEqual({
      version: sha.slice(0, 8),
      releaseSha: sha,
    });
  });

  it.each(['abc1234', 'g'.repeat(40), 'a'.repeat(41), ''])('fails closed for %j', (sha) => {
    expect(resolveReleaseIdentity({ GIT_COMMIT_SHA: sha, ENGINE_VERSION: 'development' })).toEqual({
      version: 'development',
      releaseSha: null,
    });
  });
});
