import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { reportError } from '../../../utils/errorReporter';
import type { TournamentTabProps } from './types';
import TournamentLobbyCard from '../TournamentLobbyCard';

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
      <div className="tab-pane-content" style={{ padding: 16, textAlign: 'center', color: 'rgba(255,255,255,0.5)' }}>
        Loading satellites...
      </div>
    );
  }
  
  if (error) {
    return (
      <div className="tab-pane-content" style={{ padding: 16, textAlign: 'center', color: '#ef4444' }}>
        {error}
      </div>
    );
  }

  if (satellites.length === 0) {
    return (
      <div className="tab-pane-content" style={{ padding: 16, textAlign: 'center', color: 'rgba(255,255,255,0.5)' }}>
        No upcoming satellites running for this event.
      </div>
    );
  }

  return (
    <div className="tab-pane-content" style={{ padding: '8px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {satellites.map((sat) => (
          <TournamentLobbyCard key={sat.id} tournament={sat} />
        ))}
      </div>
    </div>
  );
}
