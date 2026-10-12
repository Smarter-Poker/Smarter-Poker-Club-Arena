/**
 * THE TOURNAMENT LOBBY AND PREVIOUS HAND POPUPS, LINE BY LINE (2026-10-04).
 *
 * Dan asked for the in-game tournament lobby to be a full-screen, standard
 * lobby "with every button and stat functional", and then for a line-by-line
 * pass over what shipped. Each block below is one defect that pass found, and
 * each pins the cause rather than the symptom:
 *
 *   1. Escape on the Sign Up card closed the whole lobby under it.
 *   2. The popup claimed to be modal and never took, kept or returned focus.
 *   3. A watch made inside the popup left the popup covering the table it
 *      opened - and when that table was the one underneath, did nothing.
 *   4. Ranking and Tables navigated by themselves, so the page could not fix 3.
 *   5. A finished event's Tables tab promised tables "When The Event Starts".
 *   6. Table names truncated before the table number on a phone.
 *   7. Rewards printed "450% Of The Field Paid" on a filling event.
 *   8. Detail counted down "Starts In" on a cancelled event.
 *   9. Detail advertised "Rebuy thru Lv 8" for a window nobody configured.
 *  10. The Entries register did not mark the player's own row.
 *  11. The Ranking channel was shared by every mount of one event.
 *  12. Every tab opened at the previous tab's scroll offset.
 *  13. Previous Hand's empty panel held no focus and trapped no Tab.
 *  14. Previous Hand's foot sat under the phone's home indicator.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  TournamentEntry,
  TournamentTabProps,
  TournamentTable,
} from '../../src/components/tournament/details/types';

vi.mock('../../src/services/GameServerAPI', () => ({ getServerStatus: vi.fn(async () => null) }));
vi.mock('../../src/services/EngineStateClient', () => ({
  engineChannelClient: { onStatusChange: () => () => {} },
}));
vi.mock('../../src/services/RealtimeChannelService', () => ({
  realtimeChannelService: {
    subscribeToTournament: () => () => {},
    subscribeToLobby: () => () => {},
  },
}));
vi.mock('../../src/utils/serverClock', () => ({ serverNow: () => Date.now() }));
vi.mock('../../src/components/tournament/details/useSatellites', () => ({
  useSatellites: () => ({
    cards: [],
    registration: {},
    loading: false,
    error: null,
    retry: vi.fn(),
  }),
}));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: () => {},
}));
vi.mock('../../src/components/tournament/details/useDownlineIds', () => ({
  useDownlineIds: () => ({ downlineIds: new Set(), carriesDownline: false }),
}));
const toast = vi.hoisted(() => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => toast }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/MysteryBountyService', () => ({
  activationStatusLine: () => '',
  formatCents: String,
  topBountyCents: () => 0,
}));
vi.mock('../../src/components/tournament/RegistrationApprovalsPanel', () => ({
  default: () => null,
}));
vi.mock('../../src/components/tournament/TournamentDealReview', () => ({ default: () => null }));
vi.mock('../../src/components/tournament/TournamentLobbyCard', () => ({ default: () => null }));
vi.mock('../../src/components/tournament/HandForHandBanner', () => ({
  HandForHandBanner: () => null,
}));
vi.mock('../../src/components/tournament/details/MultiDayStagePanel', () => ({
  default: () => null,
}));
vi.mock('../../src/services/tableWarmup', () => ({
  warmTable: vi.fn(),
  observeLobbyTableWarmups: () => () => {},
}));
const channel = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock('../../src/core/MasterBus', () => {
  const fake = {
    on() {
      return fake;
    },
    subscribe() {
      return fake;
    },
  };
  return {
    masterBus: {
      getOrCreateChannel: (key: string) => {
        channel.keys.push(key);
        return fake;
      },
      removeRegisteredChannel: vi.fn(),
    },
  };
});
vi.mock('../../src/lib/supabase', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gt', 'order', 'range', 'not', 'in']) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
  return { supabase: { from: () => chain } };
});
vi.mock('../../src/pages/tournament/TournamentDetails', () => ({
  default: () => (
    <div data-testid="lobby-page">
      <button type="button">First</button>
      <button type="button">Last</button>
    </div>
  ),
}));

import TournamentLobbyModal from '../../src/components/table/TournamentLobbyModal';
import DetailOverviewTab from '../../src/components/tournament/details/DetailOverviewTab';
import EntriesTab from '../../src/components/tournament/details/EntriesTab';
import RankingTab from '../../src/components/tournament/details/RankingTab';
import RewardsTab from '../../src/components/tournament/details/RewardsTab';
import TablesTab from '../../src/components/tournament/details/TablesTab';
import { shortTableName } from '../../src/components/tournament/details/types';
import { HandDetailModal } from '../../src/components/table/HandDetailModal';

afterEach(() => {
  cleanup();
  channel.keys.length = 0;
  vi.clearAllMocks();
});

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
const PAGE = read('src/pages/tournament/TournamentDetails.tsx');

const EVENT = 'Sunday Funday Main Event';

const entry = (i: number, over: Partial<TournamentEntry> = {}): TournamentEntry =>
  ({
    id: `p${i}`,
    user_id: `u${i}`,
    username: `Player${i}`,
    avatar_url: null,
    player_code: null,
    chips: 10_000 + i * 1_000,
    status: 'playing',
    table_id: i % 2 ? 'tbl-2' : 'tbl-1',
    created_at: null,
    rebuys: 0,
    add_ons: 0,
    is_satellite_qualifier: false,
    ...over,
  }) as TournamentEntry;

const TABLES: TournamentTable[] = [
  {
    id: 'tbl-1',
    name: `${EVENT} - Table 1`,
    status: 'running',
    max_players: 9,
    current_players: 3,
    small_blind: 100,
    big_blind: 200,
  },
  {
    id: 'tbl-2',
    name: `${EVENT} - Table 2`,
    status: 'running',
    max_players: 9,
    current_players: 3,
    small_blind: 100,
    big_blind: 200,
  },
];

const NINE_PLACES = JSON.stringify(
  [30, 20, 14, 10, 8, 6, 5, 4, 3].map((percentage, i) => ({ place: i + 1, percentage }))
);

function props(over: Partial<TournamentTabProps> & { row?: Record<string, unknown> } = {}) {
  const { row, ...rest } = over;
  return {
    tournament: {
      id: 't-1',
      name: EVENT,
      club_id: 'c-1',
      status: 'RUNNING',
      game_type: 'nlh',
      table_size: 9,
      buy_in_amount: 100,
      buy_in_fee: 10,
      starting_chips: 10_000,
      prize_pool: 600,
      guaranteed_prize: 0,
      current_level: 0,
      blind_structure: [],
      payout_structure: NINE_PLACES,
      start_time: new Date(Date.now() - 600_000).toISOString(),
      started_at: new Date(Date.now() - 600_000).toISOString(),
      level_started_at: new Date(Date.now() - 60_000).toISOString(),
      ...row,
    },
    entries: [0, 1, 2, 3, 4, 5].map((i) => entry(i)),
    tables: TABLES,
    blindLevels: [
      { level: 1, smallBlind: 100, bigBlind: 200, ante: 0, duration: 10, isBreak: false },
      { level: 2, smallBlind: 200, bigBlind: 400, ante: 0, duration: 10, isBreak: false },
    ],
    currentUserId: 'u1',
    isRegistered: true,
    onWatchPlayer: vi.fn(),
    mysteryBounty: null,
    onOpenTab: vi.fn(),
    ...rest,
  } as unknown as TournamentTabProps;
}

describe('1 and 2. the popup is a real dialog', () => {
  it('leaves Escape to a dialog stacked above it', () => {
    const onClose = vi.fn();
    render(<TournamentLobbyModal isOpen tournamentId="t-1" onClose={onClose} />);
    /* The Sign Up card cancels itself from a capture-phase listener and calls
       preventDefault. The same key press then reaches this popup. */
    const press = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    press.preventDefault();
    window.dispatchEvent(press);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape alone while focus is inside another dialog', () => {
    const onClose = vi.fn();
    render(
      <>
        <TournamentLobbyModal isOpen tournamentId="t-1" onClose={onClose} />
        <div role="dialog" aria-label="Sign Up">
          <button type="button">Confirm</button>
        </div>
      </>
    );
    screen.getByRole('button', { name: 'Confirm' }).focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('takes focus when it opens and gives it back when it closes', () => {
    function Felt({ open }: { open: boolean }) {
      return (
        <>
          <button type="button">Lobby</button>
          <TournamentLobbyModal isOpen={open} tournamentId="t-1" onClose={() => {}} />
        </>
      );
    }
    const { rerender } = render(<Felt open={false} />);
    const opener = screen.getByRole('button', { name: 'Lobby' });
    opener.focus();

    rerender(<Felt open />);
    expect(screen.getByRole('dialog', { name: 'Tournament Lobby' })).toHaveFocus();

    rerender(<Felt open={false} />);
    expect(opener).toHaveFocus();
  });

  it('binds its keyboard once per open, not once per parent render', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const { rerender } = render(
      <TournamentLobbyModal isOpen tournamentId="t-1" onClose={() => {}} />
    );
    const bound = () => add.mock.calls.filter(([type]) => type === 'keydown').length;
    const before = bound();
    // TablePage hands a new inline arrow on every render.
    rerender(<TournamentLobbyModal isOpen tournamentId="t-1" onClose={() => {}} />);
    rerender(<TournamentLobbyModal isOpen tournamentId="t-1" onClose={() => {}} />);
    expect(bound()).toBe(before);
    add.mockRestore();
  });

  it('still closes with the newest handler it was given', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<TournamentLobbyModal isOpen tournamentId="t-1" onClose={first} />);
    rerender(<TournamentLobbyModal isOpen tournamentId="t-1" onClose={second} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('3 and 4. a watch made inside the popup puts the popup away', () => {
  const watch = PAGE.slice(
    PAGE.indexOf('const watchTable = useCallback('),
    PAGE.indexOf('const isWatchable =')
  );

  it('closes instead of asking for the table the popup is already covering', () => {
    expect(watch).toMatch(
      /if \(onClose && currentTableId && tableId === currentTableId\) \{\s*onClose\(\);\s*return;/
    );
  });

  it('closes behind a watch that opened another table, and not behind one that was refused', () => {
    const refused = watch.indexOf("toast.error('That Table Is Not Available To Watch')");
    const closed = watch.lastIndexOf('onClose?.()');
    expect(refused).toBeGreaterThan(-1);
    expect(closed).toBeGreaterThan(refused);
    expect(watch.slice(refused, closed)).toMatch(/return;/);
  });

  it('Ranking and Tables hold no navigate of their own', () => {
    for (const file of ['RankingTab.tsx', 'TablesTab.tsx']) {
      const src = read(`src/components/tournament/details/${file}`);
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${file} navigates by itself again`).not.toMatch(/openTableAsObserver\(/);
      expect(code, `${file} navigates by itself again`).not.toMatch(/useNavigate\(/);
    }
  });

  it('a Tables row opens through the page, with the short name for the new tab', () => {
    const onWatchPlayer = vi.fn();
    render(<TablesTab {...props({ onWatchPlayer })} />);
    fireEvent.click(screen.getByRole('button', { name: /^Watch Table 1,/ }));
    expect(onWatchPlayer).toHaveBeenCalledWith('tbl-1', 'Table 1');
  });

  it("the player's own table says where the tap goes", () => {
    render(<TablesTab {...props()} />);
    const mine = screen.getByRole('button', { name: /^Go To Your Table, Table 2,/ });
    expect(mine).toHaveTextContent('Tap To Go To Your Table');
  });

  it('a Ranking row confirms through the page', () => {
    const onWatchPlayer = vi.fn();
    render(<RankingTab {...props({ onWatchPlayer })} />);
    fireEvent.click(screen.getByRole('button', { name: /^Watch Player4,/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Watch' }));
    expect(onWatchPlayer).toHaveBeenCalledWith('tbl-1', 'Table 1');
  });
});

describe('5. an empty Tables tab says why it is empty', () => {
  const emptyFor = (status: string) => {
    const { container } = render(<TablesTab {...props({ tables: [], row: { status } })} />);
    const text = container.textContent ?? '';
    cleanup();
    return text;
  };

  it('does not promise a finished event tables when it starts', () => {
    const text = emptyFor('COMPLETED');
    expect(text).not.toContain('Tables Are Created When The Event Starts');
    expect(text).toContain('This Event Has Finished And Its Tables Are Closed');
  });

  it('has a true sentence for every other state too', () => {
    expect(emptyFor('CANCELLED')).toContain('This Event Was Cancelled');
    expect(emptyFor('RUNNING')).toContain('Seating Is Being Drawn Now');
    expect(emptyFor('REGISTERING')).toContain('Tables Are Created When The Event Starts');
  });
});

describe('6. a table is named by what differs from row to row', () => {
  it('drops the event name the header already carries', () => {
    expect(shortTableName(`${EVENT} - Table 2`, EVENT)).toBe('Table 2');
    expect(shortTableName(`${EVENT} - Final Table`, EVENT)).toBe('Final Table');
    expect(shortTableName(`${EVENT}: Table 12`, EVENT.toUpperCase())).toBe('Table 12');
  });

  it('never shortens to nothing, and leaves an unrelated name alone', () => {
    expect(shortTableName(EVENT, EVENT)).toBe(EVENT);
    expect(shortTableName(`${EVENT} - `, EVENT)).toBe(`${EVENT} -`);
    expect(shortTableName('PLO4 Heads-Up 100', EVENT)).toBe('PLO4 Heads-Up 100');
    expect(shortTableName('Table 3', null)).toBe('Table 3');
    expect(shortTableName(null, EVENT)).toBe('');
  });

  it('Ranking prints the short name under a seated player', () => {
    const { container } = render(<RankingTab {...props()} />);
    const subs = Array.from(container.querySelectorAll('.rk-sub')).map((el) => el.textContent);
    expect(subs).toContain('Table 1');
    expect(subs).toContain('Table 2');
    expect(subs.join(' ')).not.toContain(EVENT);
  });
});

describe('7. no field is more than entirely paid', () => {
  it('says nothing about the share while the ladder is longer than the field', () => {
    // Nine paid places, two entries: this printed "450% Of The Field Paid".
    const { container } = render(
      <RewardsTab {...props({ entries: [entry(0), entry(1)], row: { status: 'REGISTERING' } })} />
    );
    expect(container.textContent).not.toMatch(/Of The Field Paid/);
  });

  it('prints it once the field has outgrown the ladder', () => {
    const entries = Array.from({ length: 18 }, (_, i) => entry(i));
    const { container } = render(<RewardsTab {...props({ entries })} />);
    expect(container.textContent).toContain('50% Of The Field Paid');
  });

  it('does not call a cancelled pool Still Growing', () => {
    const { container } = render(<RewardsTab {...props({ row: { status: 'CANCELLED' } })} />);
    expect(container.textContent).not.toContain('Still Growing');
    expect(container.textContent).not.toContain('Provisional');
    expect(container.textContent).toContain('Event Cancelled');
  });
});

describe('8. a cancelled event is not about to start', () => {
  it('prints no countdown and no live tiles', () => {
    const { container } = render(
      <DetailOverviewTab
        {...props({
          tables: [],
          row: {
            status: 'CANCELLED',
            started_at: null,
            level_started_at: null,
            start_time: new Date(Date.now() + 900_000).toISOString(),
          },
        })}
      />
    );
    const text = container.textContent ?? '';
    expect(text).not.toContain('Starts In');
    expect(container.querySelector('.dov-hero__eyebrow')).toHaveTextContent('Cancelled');
    expect(container.querySelector('.dov-hero__time')).toHaveTextContent('-');
    const labels = Array.from(container.querySelectorAll('.tl-stat__label')).map(
      (el) => el.textContent
    );
    expect(labels).toEqual(['Entries', 'Buy-In', 'Status']);
  });
});

describe('9. the rebuy window is read, not assumed', () => {
  const rebuyRow = (row: Record<string, unknown>) => {
    const { container } = render(
      <DetailOverviewTab {...props({ row: { is_rebuy: true, add_on_available: true, ...row } })} />
    );
    const values: Record<string, string> = {};
    for (const item of Array.from(container.querySelectorAll('.dov-info__item'))) {
      values[item.querySelector('dt')?.textContent ?? ''] =
        item.querySelector('dd')?.textContent ?? '';
    }
    cleanup();
    return values;
  };

  it('prints no level when the event configured none', () => {
    const shown = rebuyRow({});
    expect(shown.Rebuy).toBe('10K');
    expect(shown['Add-On']).toBe('10K');
  });

  it('reads the columns in the order the rebuy rule does', () => {
    // TournamentService.canRebuy: rebuy_levels ?? late_reg_levels.
    expect(rebuyRow({ rebuy_levels: 4, late_reg_levels: 9 }).Rebuy).toBe('10K thru Lv 4');
    expect(rebuyRow({ late_reg_levels: 6 }).Rebuy).toBe('10K thru Lv 6');
  });
});

describe("10. the register marks the player's own row", () => {
  it('lights it and badges it', () => {
    const { container } = render(<EntriesTab {...props()} />);
    const lit = Array.from(container.querySelectorAll('.tl-row--hero'));
    expect(lit).toHaveLength(1);
    expect(lit[0]).toHaveTextContent('Player1');
    expect(lit[0]).toHaveTextContent('You');
  });

  it('lights nothing for a visitor who is not signed in', () => {
    const { container } = render(<EntriesTab {...props({ currentUserId: undefined })} />);
    expect(container.querySelector('.tl-row--hero')).toBeNull();
  });
});

describe('11. the Ranking channel belongs to one mount', () => {
  it('two mounts of one event do not share a key', () => {
    render(
      <>
        <RankingTab {...props()} />
        <RankingTab {...props()} />
      </>
    );
    const ranking = channel.keys.filter((k) => k.startsWith('ranking-t-1'));
    expect(ranking).toHaveLength(2);
    expect(new Set(ranking).size).toBe(2);
  });
});

describe('12. every tab opens at its top', () => {
  it('resets the one scroller when the tab changes', () => {
    expect(PAGE).toMatch(
      /const el = contentRef\.current;\s*if \(el\) el\.scrollTop = 0;\s*\}, \[activeTab, tournament\?\.id\]\);/
    );
    expect(PAGE).toMatch(/tabIndex=\{-1\}\s*ref=\{contentRef\}/);
  });
});

describe('13 and 14. Previous Hand', () => {
  const modal = (
    <>
      <button type="button">Previous Hand</button>
      <HandDetailModal isOpen onClose={() => {}} hands={[]} heroId="u1" loadState="loading" />
    </>
  );

  it('the empty panel takes focus, so the trap has something to hold', () => {
    render(modal);
    expect(screen.getByRole('dialog', { name: 'Hand Detail' })).toHaveFocus();
  });

  it('both panels carry the ref the focus trap reads', () => {
    const src = read('src/components/table/HandDetailModal.tsx');
    expect(src.match(/ref=\{panelRef\}/g)).toHaveLength(2);
  });

  it('arrow keys move focus with the selected tab', () => {
    const src = read('src/components/table/HandDetailModal.tsx');
    const handler = src.slice(src.indexOf('const onTabsKeyDown'), src.indexOf('// The viewer'));
    expect(handler).toMatch(/setTab\('summary'\);\s*summaryTabRef\.current\?\.focus\(\)/);
    expect(handler).toMatch(/setTab\('detail'\);\s*detailTabRef\.current\?\.focus\(\)/);
  });

  it('the full-screen foot pays the bottom inset on a phone', () => {
    const css = read('src/components/table/HandDetailModal.css');
    const phone = css.slice(css.indexOf('@media (max-width: 640px)'));
    expect(phone).toMatch(
      /\.hdm-panel\s*\{[^}]*padding:\s*0 12px calc\(12px \+ env\(safe-area-inset-bottom, 0px\)\) !important/
    );
  });
});
