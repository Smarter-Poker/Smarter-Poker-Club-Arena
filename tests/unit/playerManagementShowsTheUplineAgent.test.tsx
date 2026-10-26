/**
 * Player Management shows the upline agent directly under the player's or
 * agent's name (Dan, 2026-10-25: "IN THE PLAYERS MANAGEMENT TAB, I WANT TO SEE
 * THE UPLINE AGENT, UNDER THE PLAYER OR AGENTS NAME."). Simple mode used to
 * hide the upline entirely, and Advanced mode squeezed it into the subline.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../../src/hooks/useProfilePresence', () => ({
  useOnlineNow: (_id: string, loaded: boolean) => loaded,
}));

import { MemberRow } from '../../src/pages/ClubMembersPage';
import { mapRosterRow } from '../../src/services/ClubRosterService';
import { defaultRosterWorkspace } from '../../src/lib/rosterWorkspace';

function row(overrides: Record<string, unknown>, simpleMode: boolean) {
  return (
    <MemberRow
      member={mapRosterRow({
        user_id: 'u-1',
        alias: 'Rubdznuts',
        username: 'Rubdznuts',
        player_number: '1004114',
        role: 'super_agent',
        can_view_financials: true,
        total_fees: 3.46,
        downline_fees: 7.52,
        downline_total: 1,
        upline_user_id: 'u-0',
        upline_name: 'KingFish',
        ...overrides,
      })}
      position={1}
      total={1}
      query=""
      onOpen={vi.fn()}
      selectable={false}
      selected={false}
      onSelect={vi.fn()}
      columns={new Set(defaultRosterWorkspace().columns)}
      simpleMode={simpleMode}
    />
  );
}

describe('Player Management shows the upline agent under the name', () => {
  for (const simpleMode of [true, false]) {
    it(`prints the upline in the name block (${simpleMode ? 'Simple' : 'Advanced'} mode)`, () => {
      const { container } = render(row({}, simpleMode));
      const upline = container.querySelector('.member-upline');
      expect(upline).not.toBeNull();
      expect(upline).toHaveTextContent('Upline: KingFish');
      expect(upline!.closest('.member-identity')).not.toBeNull();
      expect(upline!.closest('.member-subline')).toBeNull();
      expect(screen.getAllByText(/KingFish/)).toHaveLength(1);
    });
  }

  it('prints nothing when the member has no upline', () => {
    const { container } = render(row({ upline_user_id: null, upline_name: null }, true));
    expect(container.querySelector('.member-upline')).toBeNull();
  });

  it('is not hidden in Simple mode and takes its own line', () => {
    const css = readFileSync(resolve(__dirname, '../../src/pages/ClubMembersPage.css'), 'utf8');
    const hidden = css.match(/\.members-simple \.member-username,[^{]*\{\s*display: none;/);
    expect(hidden).not.toBeNull();
    expect(hidden![0]).not.toContain('member-upline');
    expect(css).toMatch(/\.member-upline \{[^}]*flex: 0 0 100%;/);
  });
});
