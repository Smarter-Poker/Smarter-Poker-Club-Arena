import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { reportError } from '../../../utils/errorReporter';
import type { TournamentTabProps } from './types';
import TournamentLobbyCard from '../TournamentLobbyCard';

function mapSupabaseRowToCard(sat: any) {
  const tournType = String(sat.tournament_type || '').toLowerCase();
  let type: any = 'mtt';
  if (sat.is_satellite || tournType === 'satellite') type = 'satellite';
  else if (tournType === 'spin') type = 'spin';
  else if (tournType === 'sng') type = 'sng';
  else if (sat.is_mystery_bounty) type = 'mystery';
  else if (sat.is_pko) type = 'pko';
  else if (sat.is_bounty) type = 'bounty';
  let status: any = 'finished';
  const rawStatus = String(sat.status || '').toUpperCase();
  if (['ANNOUNCED', 'REGISTERING', 'LATE_REG'].includes(rawStatus)) status = 'registering';
  else if (['RUNNING'].includes(rawStatus)) status = 'running';
  else if (['CANCELLED', 'ABORTED'].includes(rawStatus)) status = 'cancelled';
  return {
    id: sat.id,
    name: sat.name || 'Satellite',
    type,
    buyIn: Number(sat.buy_in) || 0,
    prizePool: Number(sat.guarantee) || 0,
    blindStructure: 'regular',
    maxPlayers: Number(sat.max_players) || 0,
    registeredPlayers: Number(sat.current_players) || 0,
    startsAt: sat.start_time,
    status,
    blindDuration: Number(sat.blind_duration) || undefined,
  };
}

export default function SatellitesTab({ tournament }: TournamentTabProps) {
  const [satellites, setSatellites] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function fetchSatellites() {
      if (!tournament?.id) return;
      try {
        setLoading(true);
        // Only fetch satellites targeting this tournament that are registering/announced/late_reg/running
        const { data, error: fetchErr } = await supabase
          .from('tournaments')
          .select('*')
          .eq('satellite_target_id', tournament.id)
          .in('status', ['ANNOUNCED', 'REGISTERING', 'LATE_REG', 'RUNNING'])
          .order('start_time', { ascending: true });

        if (fetchErr) throw fetchErr;

        if (mounted) {
          setSatellites(data || []);
        }
      } catch (err) {
        reportError(err, 'SatellitesTab.fetchSatellites');
        if (mounted) setError('Failed to load satellites');
      } finally {
        if (mounted) setLoading(false);
      }
    }

    void fetchSatellites();

    return () => {
      mounted = false;
    };
  }, [tournament?.id]);

  if (loading) {
    return (
      <div
        className="tab-pane-content"
        style={{ padding: 16, textAlign: 'center', color: 'rgba(255,255,255,0.5)' }}
      >
        Loading Satellites...
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="tab-pane-content"
        style={{ padding: 16, textAlign: 'center', color: '#ef4444' }}
      >
        {error}
      </div>
    );
  }

  if (satellites.length === 0) {
    return (
      <div
        className="tab-pane-content"
        style={{ padding: 16, textAlign: 'center', color: 'rgba(255,255,255,0.5)' }}
      >
        No Upcoming Satellites Running For This Event.
      </div>
    );
  }

  return (
    <div className="tab-pane-content" style={{ padding: '8px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {satellites.map((sat) => (
          <TournamentLobbyCard key={sat.id} tournament={mapSupabaseRowToCard(sat)} />
        ))}
      </div>
    </div>
  );
}
