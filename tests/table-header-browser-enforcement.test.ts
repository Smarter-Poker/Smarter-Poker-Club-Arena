import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

describe('table header regression inputs require the browser gate', () => {
  it.each(['tests/e2e/support/mobileActionStripCases.ts', 'tests/e2e/mobile-lobby-chrome.spec.ts'])(
    '%s admits the existing CSS Beat job',
    (path) => {
      expect(classifyChangedPaths([path])).toMatchObject({
        src: true,
        tests: true,
        server: false,
      });
    }
  );
});
