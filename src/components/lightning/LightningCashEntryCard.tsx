import { NlhPremiumCard } from '../lobby/game-cards/NlhPremiumCard';
import { lightningStakeText } from '../../lightning/lightningStakeText';
import { titleCase } from '../../utils/titleCase';
import type { ArenaGameCardActions } from '../lobby/game-cards/arenaGameCardTypes';
import './LightningCashEntryCard.css';

/** The cash-game card, with no entry-page prose or second panel. */
export default function LightningCashEntryCard({
  title,
  variant,
  stakes,
  players,
  buyIn,
  status,
  actions,
  primaryTestId,
}: {
  title: string;
  variant: string;
  stakes: string;
  players?: number | null;
  buyIn?: string;
  status: string;
  actions: ArenaGameCardActions;
  primaryTestId?: string;
}) {
  return (
    <div className="lightning-cash-card" aria-label={titleCase(lightningStakeText(title))}>
      <NlhPremiumCard
        data={{
          id: 'lightning-entry',
          family: 'nlh',
          title: titleCase(lightningStakeText(title).replace(/\s+Games$/i, '')),
          gameType: variant.toUpperCase(),
          stakes: lightningStakeText(stakes),
          players: players == null ? undefined : players.toLocaleString(),
          buyIn,
          status: status === 'Running' ? 'running' : 'closed',
          statusLabel: titleCase(status),
          statusTone: 'blue',
          rules: [],
        }}
        actions={actions}
        primaryTestId={primaryTestId}
        gameTypeLabel={variant}
      />
    </div>
  );
}
