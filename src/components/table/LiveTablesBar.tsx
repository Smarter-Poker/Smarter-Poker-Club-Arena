/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LIVE TABLES BAR — "you have games running" resume affordance
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-19: multi-table play keeps a player's seats alive on the server
 * (table_seats.left_at IS NULL) even when they navigate the lobby on the
 * /clubs routes, where MultiTablePage is unmounted. Until now NOTHING in the
 * lobby showed that those games existed — a player who wandered off had no way
 * back except remembering the table URL, while their stacks blinded away.
 *
 * This bar renders on the standalone club lobby whenever the signed-in user
 * has at least one active seat. Tapping it returns to /table/:firstId, where
 * MultiTablePage's server-truth rebuild re-opens EVERY live seat as a tab.
 *
 * Kept intentionally read-only: it never mutates seats, it only navigates.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import './LiveTablesBar.css';

interface LiveSeat {
  tableId: string;
  name: string;
}

export default function LiveTablesBar() {
  const { user } = useAuthUser();
  const navigate = useNavigate();
  const [seats, setSeats] = useState<LiveSeat[]>([]);
  const aliveRef = useRef(true);

  const reload = useCallback(async () => {
    if (!user?.id) return;
    try {
      const { data: seatRows, error } = await supabase
        .from('table_seats')
        .select('table_id')
        .eq('user_id', user.id)
        .is('left_at', null);
      if (error || !aliveRef.current) return;
      const ids = Array.from(
        new Set((seatRows ?? []).map((r) => r.table_id as string).filter(Boolean))
      );
      if (ids.length === 0) {
        setSeats([]);
        return;
      }
      const { data: tblRows } = await supabase.from('tables').select('id, name').in('id', ids);
      if (!aliveRef.current) return;
      setSeats(
        ids.map((id) => ({
          tableId: id,
          name: (tblRows?.find((t) => t.id === id)?.name as string) || 'Table',
        }))
      );
    } catch {
      /* transient — the next TABLE_SEATED/TABLE_LEFT tick retries */
    }
  }, [user?.id]);

  useEffect(() => {
    aliveRef.current = true;
    reload();
    return () => {
      aliveRef.current = false;
    };
  }, [reload]);

  // Seats change exactly on these bus events; debounce coalesces bursts.
  useMasterBusSubscription('TABLE_SEATED', reload, { debounce: 500 });
  useMasterBusSubscription('TABLE_LEFT', reload, { debounce: 500 });

  if (seats.length === 0) return null;

  const label =
    seats.length === 1 ? seats[0].name : `${seats.length} live tables`;

  return (
    <button
      className="live-tables-bar"
      onClick={() => navigate(`/table/${seats[0].tableId}`)}
      title="Return to your live tables"
    >
      <span className="live-tables-bar__dot" aria-hidden="true">●</span>
      <span className="live-tables-bar__label">{label}</span>
      <span className="live-tables-bar__cta">Return to game →</span>
    </button>
  );
}
