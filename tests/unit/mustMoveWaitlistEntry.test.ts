import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sliceMethod } from '../helpers/sourceWindow';

const source = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
const handler = sliceMethod(source, 'const handleOpenWaitlist = useCallback(() => {');

describe('the full Must-Move table reaches its game entry door', () => {
  it.each(['game-1', null])('routes cluster=%s to the appropriate existing lobby', (clusterId) => {
    const body = handler.slice(handler.indexOf('{') + 1, handler.lastIndexOf('}'));
    const loadWaitlist = vi.fn();
    const setShowWaitList = vi.fn();
    const setShowMustMoveLobby = vi.fn();
    const open = new Function(
      'tableState',
      'loadWaitlist',
      'setShowWaitList',
      'setShowMustMoveLobby',
      body
    );
    open({ clusterId }, loadWaitlist, setShowWaitList, setShowMustMoveLobby);
    if (clusterId) {
      expect(setShowMustMoveLobby).toHaveBeenCalledExactlyOnceWith(true);
      expect(loadWaitlist).not.toHaveBeenCalled();
      expect(setShowWaitList).not.toHaveBeenCalled();
    } else {
      expect(loadWaitlist).toHaveBeenCalledOnce();
      expect(setShowWaitList).toHaveBeenCalledExactlyOnceWith(true);
      expect(setShowMustMoveLobby).not.toHaveBeenCalled();
    }
  });

  it('refreshes the handler when the game changes and keeps the footer connected', () => {
    expect(source).toContain('}, [loadWaitlist, tableState.clusterId]);');
    expect(source).toMatch(
      /className="spectator-footer-bar__cta"\s+onClick=\{handleOpenWaitlist\}/
    );
  });
});
