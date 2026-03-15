/**
 *  CLUB ENGINE — Quick Actions
 * Hero section quick action buttons
 */

import { useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useAuthUser } from '../../hooks/useAuthUser';
import { supabase } from '../../lib/supabase';
import { useToast } from '../common/Toast';
import styles from './QuickActions.module.css';

export default function QuickActions() {
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());

  useEffect(() => {
    const items = 3;
    for (let i = 0; i < items; i++) {
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60);
    }
  }, []);
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();

  /**
   * Quick Seat — finds a table with open seats and navigates directly to it.
   * UNION-FIRST: Only searches tables belonging to the user's union.
   * Prioritizes tables with more players (more action) that aren't full.
   */
  const handleQuickSeat = async () => {
    if (!user?.id) {
      toast.error('Please log in to join a table');
      navigate('/login');
      return;
    }

    try {
      // UNION-FIRST: Find the user's union first
      const { data: memberships } = await supabase
        .from('club_members')
        .select('club_id')
        .eq('user_id', user.id);

      let unionClubIds: string[] = [];

      if (memberships?.length) {
        const clubIds = memberships.map((m) => m.club_id);
        // Check if any clubs are in a union
        const { data: unionClubs } = await supabase
          .from('union_clubs')
          .select('club_id')
          .in('club_id', clubIds);

        if (unionClubs?.length) {
          // Get ALL clubs in the same union (not just user's club)
          const { data: firstUnion } = await supabase
            .from('union_clubs')
            .select('union_id')
            .in('club_id', clubIds)
            .limit(1)
            .maybeSingle();

          if (firstUnion) {
            const { data: allUnionClubs } = await supabase
              .from('union_clubs')
              .select('club_id')
              .eq('union_id', firstUnion.union_id);

            unionClubIds = (allUnionClubs || []).map((c) => c.club_id);
          }
        }
      }

      // Build the query — filtered to union tables if user is in a union
      let query = supabase
        .from('tables')
        .select('id, name, current_players, max_players')
        .eq('status', 'active')
        .eq('is_deleted', false)
        .gt('max_players', 0)
        .order('current_players', { ascending: false });

      if (unionClubIds.length > 0) {
        query = query.in('club_id', unionClubIds);
      }

      const { data: tables, error } = await query;

      if (error) throw error;

      // Find first table that isn't full
      const openTable = tables?.find((t) => (t.current_players || 0) < (t.max_players || 9));

      if (openTable) {
        navigate(`/table/${openTable.id}`);
      } else {
        toast.error('No tables with open seats right now');
      }
    } catch (err) {
      console.error('Quick seat error:', err);
      toast.error('Failed to find an open table');
    }
  };

  /**
   * Create Table — navigates to club selection first (tables belong to clubs)
   */
  const handleCreateTable = () => {
    if (!user?.id) {
      toast.error('Please log in to create a table');
      navigate('/login');
      return;
    }
    // Navigate to clubs page — user picks a club, then creates table within it
    navigate('/clubs');
  };

  return (
    <div className={styles.actions}>
      <button
        className={styles.actionButton}
        onClick={() => navigate('/clubs')}
        style={{
          opacity: visibleItems.has(0) ? 1 : 0,
          transform: visibleItems.has(0) ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <span className={styles.actionIcon}></span>
        <span className={styles.actionLabel}>My Clubs</span>
      </button>
      <button
        className={styles.actionButton}
        onClick={handleCreateTable}
        style={{
          opacity: visibleItems.has(1) ? 1 : 0,
          transform: visibleItems.has(1) ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <span className={styles.actionIcon}>➕</span>
        <span className={styles.actionLabel}>Create Table</span>
      </button>
      <button
        className={`${styles.actionButton} ${styles.primary}`}
        onClick={handleQuickSeat}
        style={{
          opacity: visibleItems.has(2) ? 1 : 0,
          transform: visibleItems.has(2) ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <span className={styles.actionIcon}></span>
        <span className={styles.actionLabel}>Quick Seat</span>
      </button>
    </div>
  );
}
