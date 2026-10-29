import { describe, expect, it } from 'vitest';
import { cssPreloadRetryPlugin } from '../scripts/vite-css-preload-retry.mjs';

describe('Vite CSS preload memo repair', () => {
  const helper = '() => rej(new Error(`Unable to preload CSS for ${dep}`))';
  const transform = (code: string, id: string) => {
    const plugin = cssPreloadRetryPlugin();
    const handler = plugin.transform as (
      this: { error: (message: string) => never },
      code: string,
      id: string
    ) => { code: string } | null;
    return handler.call(
      {
        error(message: string) {
          throw new Error(message);
        },
      },
      code,
      id
    );
  };
  it('invalidates the failed CSS memo and link before preserving rejection', () => {
    const result = transform(helper, '\0vite/preload-helper.js');
    expect(result.code.indexOf('delete seen[dep]')).toBeLessThan(result.code.indexOf('rej('));
    expect(result.code.indexOf('link.remove()')).toBeLessThan(result.code.indexOf('rej('));
    expect(result.code).toContain('Unable to preload CSS for ${dep}');
  });
  it('leaves unrelated modules untouched', () => {
    expect(transform(helper, '/src/pages/TablePage.tsx')).toBeNull();
  });
  it.each(['unrecognized helper', helper + helper])(
    'refuses changed or ambiguous helper source',
    (source) => {
      expect(() => transform(source, '\0vite/preload-helper.js')).toThrow(
        'Vite CSS preload helper changed'
      );
    }
  );
});
