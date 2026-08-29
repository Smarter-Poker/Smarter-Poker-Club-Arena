import { memo, useMemo } from 'react';
import type { LobbyEntry } from '../lobbyEntries';
import { lobbyPlayerStateOf as playerStateOf, type LobbyRowContext } from '../lobbyCardContext';
import { arenaGameCardDataFromEntry } from './arenaGameCardAdapter';
import ArenaGameCard from './ArenaGameCard';
import type { ArenaGameCardActions } from './arenaGameCardTypes';

function actionsFor(entry: LobbyEntry, ctx: LobbyRowContext): ArenaGameCardActions {
  const mine = playerStateOf(entry, ctx);

  if (entry.kind === 'cash') {
    if (mine === 'seated') {
      return {
        primaryLabel: 'Return To Game',
        onPrimary: () => ctx.onViewTable?.(entry),
        secondaryLabel: 'Details',
        onSecondary: () => ctx.onViewTable?.(entry),
      };
    }
    if (entry.status === 'full' || entry.status === 'waitlist') {
      const joined = mine === 'waitlisted';
      return {
        primaryLabel: joined ? 'Leave Waitlist' : 'Join Waitlist',
        onPrimary: () => ctx.onWaitlistToggle?.(entry.id, !joined),
        primaryDisabled: !ctx.onWaitlistToggle,
        secondaryLabel: 'Watch Table',
        onSecondary: () => ctx.onViewTable?.(entry),
      };
    }
    return {
      primaryLabel: 'Join Table',
      onPrimary: () => ctx.onJoinTable?.(entry),
      primaryDisabled: !ctx.onJoinTable,
      secondaryLabel: 'View Table',
      onSecondary: () => ctx.onViewTable?.(entry),
    };
  }

  if (entry.kind === 'spin' || (entry.kind === 'sng' && entry.capacity <= 2)) {
    if (
      mine ||
      entry.status === 'running' ||
      entry.status === 'closed' ||
      entry.status === 'full'
    ) {
      return {
        primaryLabel: mine ? 'Return To Game' : 'Watch',
        onPrimary: () => ctx.onViewTable?.(entry),
      };
    }
    return {
      primaryLabel: 'Sit Down',
      onPrimary: () => ctx.onSpinJoin?.(entry, entry.kind === 'spin' ? 'spin' : 'sng'),
      primaryDisabled: !ctx.onSpinJoin,
    };
  }

  const registered = mine === 'registered';
  const running =
    entry.status === 'running' || entry.status === 'completed' || entry.status === 'closed';
  return {
    primaryLabel: running
      ? registered
        ? 'Return To Game'
        : 'Watch'
      : registered
        ? 'Registered'
        : 'Register',
    onPrimary: () => (running || registered ? ctx.onViewTable?.(entry) : ctx.onRegister?.(entry)),
    primaryDisabled: running || registered ? !ctx.onViewTable : !ctx.onRegister,
    secondaryLabel: 'Details',
    onSecondary: () => ctx.onViewTable?.(entry),
  };
}

export const ArenaLobbyGameCard = memo(function ArenaLobbyGameCard({
  entry,
  ctx,
  selected,
  onSelect,
}: {
  entry: LobbyEntry;
  ctx: LobbyRowContext;
  selected?: boolean;
  onSelect?: (entry: LobbyEntry) => void;
}) {
  const data = useMemo(() => {
    const normalized = arenaGameCardDataFromEntry(entry);
    const playerState = playerStateOf(entry, ctx);
    return { ...normalized, registeredByViewer: playerState === 'registered' };
  }, [entry, ctx]);
  const actions = useMemo(() => actionsFor(entry, ctx), [entry, ctx]);

  return (
    <div onFocus={() => onSelect?.(entry)}>
      <ArenaGameCard data={data} actions={actions} presentation="mobile" selected={selected} />
    </div>
  );
});
