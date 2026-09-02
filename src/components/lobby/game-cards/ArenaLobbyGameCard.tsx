import { memo, useMemo } from 'react';
import type { LobbyEntry } from '../lobbyEntries';
import { lobbyPlayerStateOf as playerStateOf, type LobbyRowContext } from '../lobbyCardContext';
import { arenaGameCardDataFromEntry } from './arenaGameCardAdapter';
import ArenaGameCard from './ArenaGameCard';
import type { ArenaGameCardActions } from './arenaGameCardTypes';

export function arenaGameCardActionsForEntry(
  entry: LobbyEntry,
  ctx: LobbyRowContext
): ArenaGameCardActions {
  const mine = playerStateOf(entry, ctx);

  if (entry.kind === 'cash') {
    if (mine === 'seated') {
      return {
        primaryLabel: 'Return To Game',
        primaryTone: 'green',
        onPrimary: () => ctx.onViewTable?.(entry),
        secondaryLabel: 'Details',
        onSecondary: () => ctx.onViewTable?.(entry),
      };
    }
    if (entry.status === 'full' || entry.status === 'waitlist') {
      const joined = mine === 'waitlisted';
      return {
        primaryLabel: joined ? 'Leave Waitlist' : 'Join Waitlist',
        primaryTone: joined ? 'red' : 'blue',
        onPrimary: () => ctx.onWaitlistToggle?.(entry.id, !joined),
        primaryDisabled: !ctx.onWaitlistToggle,
        secondaryLabel: 'Watch Table',
        onSecondary: () => ctx.onViewTable?.(entry),
      };
    }
    return {
      primaryLabel: 'Join Table',
      primaryTone: 'blue',
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
        primaryTone: mine ? 'green' : 'neutral',
        onPrimary: () => ctx.onViewTable?.(entry),
      };
    }
    return {
      primaryLabel: 'Sit Down',
      primaryTone: 'blue',
      onPrimary: () => ctx.onSpinJoin?.(entry, entry.kind === 'spin' ? 'spin' : 'sng'),
      primaryDisabled: !ctx.onSpinJoin,
    };
  }

  const registered = mine === 'registered';
  const running =
    entry.status === 'running' || entry.status === 'completed' || entry.status === 'closed';
  if (registered && (entry.status === 'running' || entry.status === 'late_reg')) {
    return {
      primaryLabel: 'Return To Tournament',
      primaryTone: 'gold',
      busy: ctx.actionBusy,
      onPrimary: () => ctx.onViewTable?.(entry),
      primaryDisabled: !ctx.onViewTable,
      secondaryLabel: 'Details',
      onSecondary: () => ctx.onViewTable?.(entry),
    };
  }
  if (registered) {
    return {
      primaryLabel: 'Unregister',
      primaryTone: 'red',
      busy: ctx.actionBusy,
      onPrimary: () => ctx.onUnregister?.(entry),
      primaryDisabled: !ctx.onUnregister,
      secondaryLabel: 'Details',
      onSecondary: () => ctx.onViewTable?.(entry),
    };
  }
  const full = entry.capacity > 0 && entry.players >= entry.capacity;
  const registrationClosed = running || full;
  return {
    primaryLabel: registrationClosed
      ? full
        ? 'Tournament Full'
        : 'Registration Closed'
      : entry.status === 'late_reg'
        ? 'Late Register'
        : 'Register',
    primaryTone: entry.status === 'late_reg' ? 'gold' : registrationClosed ? 'neutral' : 'blue',
    busy: ctx.actionBusy,
    onPrimary: () => ctx.onRegister?.(entry),
    primaryDisabled: registrationClosed || !ctx.onRegister,
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
  const actions = useMemo(() => arenaGameCardActionsForEntry(entry, ctx), [entry, ctx]);

  return (
    <div onFocus={() => onSelect?.(entry)}>
      <ArenaGameCard data={data} actions={actions} presentation="mobile" selected={selected} />
    </div>
  );
});
