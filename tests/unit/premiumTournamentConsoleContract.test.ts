import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const PAGE = read('src/pages/tournament/TournamentDetails.tsx');
const TYPES = read('src/components/tournament/details/types.ts');
const PREMIUM = read('src/pages/tournament/PremiumTournamentConsole.css');
const GAME_PANEL = read('src/components/lobby/GameLobbyPanel.tsx');
const GAME_PREMIUM = read('src/components/lobby/PremiumGameLobbyPanel.css');

describe('approved premium tournament console contract', () => {
  it('publishes exactly the seven approved tab labels', () => {
    for (const label of [
      'Details',
      'Blinds',
      'Ranking',
      'Entries',
      'Unions',
      'Tables',
      'Rewards',
    ]) {
      expect(TYPES).toContain(`label: '${label}'`);
    }
    expect(TYPES).not.toContain("label: 'Detail'");
    expect(TYPES).not.toContain("label: 'Satellites'");
  });

  it('keeps all seven tabs on the shared live tab contract', () => {
    for (const id of ['detail', 'blinds', 'ranking', 'entries', 'unions', 'tables', 'rewards']) {
      expect(PAGE).toContain(`activeTab === '${id}'`);
    }
    expect(PAGE).toContain('data-active-tab={activeTab}');
  });

  it('fills the complete tab rail instead of leaving a dead right side', () => {
    const rail = PREMIUM.slice(
      PREMIUM.indexOf('.tournament-details .details-tabs {'),
      PREMIUM.indexOf('.tournament-details .details-tabs .tab.active')
    );
    expect(rail).toContain('display: flex');
    expect(rail).toContain('flex-wrap: wrap');
    expect(rail).toMatch(/flex:\s*1 1 110px/);
    expect(rail).not.toMatch(/width:\s*(?:fit-content|max-content)/);
  });

  it('keeps every tab vertically scrollable inside the fixed chassis', () => {
    expect(PREMIUM).toContain('.tournament-details .details-content > *');
    expect(read('src/pages/tournament/TournamentDetails.css')).toMatch(
      /\.details-content\s*>\s*\*\s*{[^}]*overflow-y:\s*auto/s
    );
  });

  it('keeps dynamic blue, green and red action states in the machine footer', () => {
    expect(PREMIUM).toContain('.details-footer .btn-register');
    expect(PREMIUM).toContain('.details-footer .btn-unregister');
    expect(PREMIUM).toContain('.details-footer .tournament-status-badge.running');
  });
});

describe('approved premium cash-table machine contract', () => {
  it('scopes the premium machine to cash lobbies', () => {
    expect(GAME_PANEL).toContain("className={`glp${isCash ? ' glp--cash' : ''}`}");
    expect(GAME_PREMIUM).toContain('.glp--cash .cplaque');
  });

  it('retains real join and observe actions', () => {
    expect(GAME_PANEL).toContain("label: 'Join Table'");
    expect(GAME_PANEL).toContain('onJoinTable(entry.id)');
    expect(GAME_PANEL).toContain('to={`/table/${entry.id}`}');
    expect(GAME_PANEL).toContain('Observe Table');
  });

  it('keeps the table machine vertically scrollable', () => {
    expect(read('src/components/lobby/GameLobbyPanel.css')).toMatch(
      /\.glp__scroll\s*{[^}]*overflow-y:\s*auto/s
    );
    expect(GAME_PREMIUM).toContain('.glp--cash .glp__scroll::-webkit-scrollbar-thumb');
  });
});
