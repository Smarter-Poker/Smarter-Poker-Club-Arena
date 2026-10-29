import { useCallback } from 'react';
import { useTournamentRegistration } from '../../../hooks/useTournamentRegistration';
import type { SatellitesState } from './useSatellites';

/** Uses the same confirmed, idempotent purchase flow as the event header. */
export function useSatelliteRegistration(cards: SatellitesState['cards'], refresh: () => void) {
  const { register } = useTournamentRegistration();
  return useCallback(
    async (id: string) => {
      const satellite = cards.find((card) => card.id === id);
      if (!satellite) return;
      await register(
        {
          id: satellite.id,
          name: satellite.name,
          buy_in_amount: satellite.buy_in_amount,
          buy_in_fee: satellite.buy_in_fee,
          club_id: satellite.club_id,
          union_id: satellite.union_id,
          status: satellite.storedStatus,
          start_time: satellite.startsAt,
          startsWhenFull: satellite.startsWhenFull,
        },
        refresh
      );
    },
    [cards, register, refresh]
  );
}
