/** Owner October 22: filters return only at their original position. Natural
 * document flow replaces the former footer-direction visibility machine. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ClubLobbyCommandTop } from '../../src/components/lobby/ClubLobbyCommandTop';
afterEach(cleanup);
const read = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
describe('filters stay in natural page flow', () => {
  it('does not attach the scroll-direction hiding mechanism', () => {
    render(<ClubLobbyCommandTop welcome={null} controls={<button>All</button>} campaign={null} />);
    expect(
      screen.getByLabelText('Club Lobby Controls And Promotion').hasAttribute('data-filters-hidden')
    ).toBe(false);
    expect(read('src/components/lobby/ClubLobbyCommandTop.tsx')).not.toContain(
      'useHideLobbyFiltersOnScroll'
    );
  });
  it('places both selector and sort controls in their original slots', () => {
    for (const [file, selector] of [
      [
        'ClubLobbyCommandTop.css',
        '.club-lobby-machine > .club-lobby-command-top > .club-lobby-command-top__controls',
      ],
      ['LobbySortBar.css', '.lobby-sortbar'],
    ]) {
      const css = read(`src/components/lobby/${file}`);
      const at = css.lastIndexOf(`${selector} {`);
      const body = css.slice(at, css.indexOf('}', at));
      expect(body).toContain('position: relative');
      expect(body).toContain('top: auto');
    }
  });
});
