import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArenaLobbyGameCard } from '../../src/components/lobby/game-cards/ArenaLobbyGameCard';
import { columnsFor } from '../../src/components/lobby/LobbyTable';
import GameLobbyPanel from '../../src/components/lobby/GameLobbyPanel';
import { WaitlistCallToAction } from '../../src/components/table/WaitlistCallToAction';
import { cashEntry } from '../../src/components/lobby/lobbyEntries';
import type { LobbyRowContext } from '../../src/components/lobby/lobbyCardContext';
vi.mock('../../src/services/tableWarmup', () => ({ warmTable: vi.fn(), observeLobbyTableWarmups: () => () => {} }));
vi.mock('../../src/services/WaitlistService', () => ({ waitlistService: { getTableWaitlist: vi.fn(async () => []) } }));
vi.mock('../../src/services/TableService', () => ({ tableService: { getAveragePot: vi.fn(async () => null) } }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: () => { const q: any = {}; for (const m of ['select','eq','is','order','limit']) q[m] = () => q; q.then = (r: any) => Promise.resolve({ data: [], error: null }).then(r); return q; } } }));
vi.mock('../../src/hooks/useSpinTierAvailability', () => ({ useSpinTierAvailability: () => ({ can_draw_100x: false }) }));
afterEach(cleanup);
const entry = (lightning: boolean) => {
  const e = cashEntry({ id:'anchor', name:'NLH', game_variant:'nlh', small_blind: .25, big_blind:.5, min_buy_in:20, max_buy_in:100, current_players:6, max_players:6, status:'active' });
  return { ...e, ...(lightning ? { game: { id:'cluster', mustMove:true, template:'action', tables:1, state:'active', lightning:{ players:6, status:'ACTIVE' as const } } } : {}) };
};
const context = (): LobbyRowContext => ({ waitlistedIds:new Set(['anchor']), seatedIds:new Set(), registeredIds:new Set(), favoriteIds:new Set(), onJoinTable:vi.fn(), onViewTable:vi.fn(), onWaitlistToggle:vi.fn() });
describe('Lightning enters the game, never a physical table waitlist', () => {
  it.each(['card','row','panel'])('%s offers Join Lightning even when its physical anchor is full', (surface) => {
    const e = entry(true); const ctx = context();
    const actions = columnsFor('HOLDEM').find(c => c.key === 'actions')!;
    render(<MemoryRouter>{surface === 'card' ? <ArenaLobbyGameCard entry={e} ctx={ctx} /> : surface === 'row' ? actions.render(e, ctx) : <GameLobbyPanel entry={e} clubId="club" currentUserId="viewer" waitlisted seated={false} registered={false} busy={false} onClose={vi.fn()} onJoinTable={id => ctx.onJoinTable?.(e)} onWaitlistToggle={ctx.onWaitlistToggle!} onRegister={vi.fn()} onUnregister={vi.fn()} onSpinJoin={vi.fn()} />}</MemoryRouter>);
    expect(screen.queryByRole('button', {name:/waitlist|waiting list/i})).toBeNull();
    fireEvent.click(screen.getAllByRole('button').find(b => /Join Lightning/.test(b.textContent ?? ''))!);
    expect(ctx.onJoinTable).toHaveBeenCalledTimes(1);
    expect(ctx.onWaitlistToggle).not.toHaveBeenCalled();
  });
  it('preserves the real Classic full-table queue', () => {
    const ctx = context(); ctx.waitlistedIds.clear();
    render(<ArenaLobbyGameCard entry={entry(false)} ctx={ctx} />);
    fireEvent.click(screen.getByRole('button', {name:'Join Waitlist'}));
    expect(ctx.onWaitlistToggle).toHaveBeenCalledWith('anchor',true);
    expect(ctx.onJoinTable).not.toHaveBeenCalled();
  });
  it('the existing painted footer offers direct Lightning entry without queue text or counts', () => {
    const join = vi.fn();
    render(<WaitlistCallToAction lightning onClick={join} waitingCount={7} position={3} />);
    fireEvent.click(screen.getByRole('button', {name:'Lightning Games. Join Lightning'}));
    expect(join).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Waiting|Position|Table Full|#3/)).toBeNull();
  });
});
