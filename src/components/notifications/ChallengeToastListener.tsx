import React, { useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { dailyChallengeService } from '../../services/DailyChallengeService';

export function ChallengeToastListener() {
  const { user } = useAuthUser();
  const toast = useToast();
  // Keep track of processed completed ids so we don't double-toast
  // on reconnects or duplicate payloads
  const processedRef = useRef<Set<string>>(new Set());

  // PERF 2026-08-24: the effect below used to depend on [user, toast].
  // `user` is the whole object out of useUserStore, so ANY store write - a
  // profile load, a balance tick, an avatar change - gave it a fresh identity
  // and tore this Realtime channel down and re-subscribed it. This component is
  // mounted in the app shell (App.tsx), so that churn happened for EVERY user
  // for the entire session. Depending on user?.id (a string) makes the channel
  // outlive unrelated store writes; `toast` rides in a ref so its identity
  // cannot re-trigger the effect either.
  const userId = user?.id;
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel(`challenges-toast-${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'user_daily_challenges',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const oldRecord = payload.old;
          const newRecord = payload.new;

          // If the old record had completed=false and the new one has completed=true
          if (oldRecord.completed === false && newRecord.completed === true) {
            if (processedRef.current.has(newRecord.id)) return;
            processedRef.current.add(newRecord.id);

            // Resolve the challenge metadata
            const challenge = dailyChallengeService.findInPools(newRecord.challenge_id);
            if (challenge) {
              toastRef.current.success(
                `Challenge Complete: ${challenge.name}! Check Hub to claim.`
              );
            }
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  return null;
}
