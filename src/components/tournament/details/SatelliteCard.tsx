import TournamentLobbyCard from '../TournamentLobbyCard';
import { useSatelliteRegistration } from './useSatelliteRegistration';
import type { SatellitesState } from './useSatellites';

type Props = {
  tournament: SatellitesState['cards'][number];
  knownRegistration: boolean | null;
  onRegistered: () => void;
};

/** A normal lobby section with the shared confirmed registration flow. */
export default function SatelliteCard({ tournament, knownRegistration, onRegistered }: Props) {
  const register = useSatelliteRegistration([tournament], onRegistered);
  return (
    <TournamentLobbyCard
      unframed
      tournament={tournament}
      knownRegistration={knownRegistration}
      onRegister={register}
    />
  );
}
