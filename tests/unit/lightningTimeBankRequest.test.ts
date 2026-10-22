import { describe, expect, it } from 'vitest';
import { lightningTimeBankRequest } from '../../src/utils/lightningTimeBankRequest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('a Lightning Time Bank reply belongs to its original decision', () => {
  it.each(['handId', 'actionContext', 'scope', 'mounted'] as const)(
    'fences a delayed reply after %s changes',
    async (key) => {
      const state = {
        scope: 'pool:user',
        lightning: true,
        handId: 'hand',
        actionContext: 'decision',
        mounted: true,
      };
      const request = lightningTimeBankRequest(() => state);
      let resolve!: () => void;
      const pending = new Promise<void>((r) => {
        resolve = r;
      }).then(() => request.isCurrent());
      if (key === 'mounted') state.mounted = false;
      else state[key] = 'different';
      resolve();
      expect(await pending).toBe(false);
      expect(request.decision).toEqual({ handId: 'hand', actionContext: 'decision' });
    }
  );
  it('requires actual server context only in Lightning', () => {
    const state = { scope: 'pool:user', lightning: true, handId: null, mounted: true };
    expect(lightningTimeBankRequest(() => state).mayDispatch).toBe(false);
    state.lightning = false;
    expect(lightningTimeBankRequest(() => state)).toMatchObject({
      mayDispatch: true,
      decision: undefined,
    });
  });
  it('wires both actual TablePage request paths through context and post-await fencing', () => {
    const page = readFileSync(resolve(process.cwd(), 'src/pages/TablePage.tsx'), 'utf8');
    expect(
      page.match(/GameServerAPI\.activateTimeBank\(tableId, userId, request\.decision\)/g)
    ).toHaveLength(2);
    expect(page.match(/if \(!request\.isCurrent\(\)\) return;/g)).toHaveLength(2);
  });
});
