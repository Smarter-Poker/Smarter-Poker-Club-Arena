import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAppNavigate } from '../../context/InTabLobbyContext';
import ArenaGameCard from '../lobby/game-cards/ArenaGameCard';

interface CashTable {
  id: string;
  name: string;
  small_blind: number;
  big_blind: number;
  min_buy_in: number;
  max_buy_in: number;
  current_players: number;
  max_players: number;
}
/** Uses the existing table route, card and engine. Entry alone never purchases a seat. */
export default function DiamondCashLobby({ arenaId }: { arenaId: string }) {
  const navigate = useAppNavigate();
  const [state, setState] = useState<{ tables: CashTable[]; failed: boolean; loaded: boolean }>({
    tables: [],
    failed: false,
    loaded: false,
  });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    let request = 0;
    const refresh = async () => {
      const generation = ++request;
      try {
        const { data, error } = await supabase
          .from('tables')
          .select(
            'id, name, small_blind, big_blind, min_buy_in, max_buy_in, current_players, max_players'
          )
          .eq('club_id', arenaId)
          .is('union_id', null)
          .eq('game_type', 'cash')
          .eq('game_variant', 'nlh')
          .is('tournament_id', null)
          .is('cluster_id', null)
          .eq('is_template', false)
          .in('status', ['waiting', 'playing', 'active', 'running'])
          .order('big_blind', { ascending: true });
        if (alive && generation === request)
          setState({
            tables: error ? [] : ((data ?? []) as CashTable[]),
            failed: !!error,
            loaded: true,
          });
      } catch {
        if (alive && generation === request) setState({ tables: [], failed: true, loaded: true });
      }
    };
    void refresh();
    const focus = () => {
      void refresh();
    };
    window.addEventListener('focus', focus);
    const unsubscribers = [
      masterBus.subscribeDebounced('TABLE_SEATED', focus, 300),
      masterBus.subscribeDebounced('TABLE_LEFT', focus, 300),
      masterBus.subscribeDebounced('TABLE_UPDATED', focus, 300),
      masterBus.subscribeDebounced('TABLE_CREATED', focus, 300),
      masterBus.subscribeDebounced('TABLE_CLOSED', focus, 300),
    ];
    return () => {
      alive = false;
      ++request;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      window.removeEventListener('focus', focus);
    };
  }, [arenaId, retry]);
  if (state.failed)
    return (
      <p role="alert">
        Could Not Load Diamond Tables.{' '}
        <button onClick={() => setRetry((v) => v + 1)}>Retry Tables</button>
      </p>
    );
  if (!state.loaded) return <p role="status">Loading Diamond Tables</p>;
  if (!state.tables.length) return <p role="status">No Diamond Cash Tables Are Available.</p>;
  return (
    <section aria-label="Diamond Cash Tables">
      {state.tables.map((table) => (
        <ArenaGameCard
          key={table.id}
          data={{
            id: table.id,
            family: 'nlh',
            title: table.name,
            gameType: 'NLH',
            subtitle: 'Diamonds',
            stakes: `${table.small_blind}/${table.big_blind} Diamonds`,
            players: `${table.current_players}/${table.max_players}`,
            buyIn: `${table.min_buy_in} - ${table.max_buy_in} Diamonds`,
            status: table.current_players >= table.max_players ? 'full' : 'open',
            statusLabel: table.current_players >= table.max_players ? 'Full' : 'Open',
            rules: [],
            dataState: 'loaded',
          }}
          actions={{ primaryLabel: 'View Table', onPrimary: () => navigate(`/table/${table.id}`) }}
        />
      ))}
    </section>
  );
}
