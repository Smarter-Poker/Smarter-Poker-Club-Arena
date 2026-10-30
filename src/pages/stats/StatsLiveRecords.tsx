import { useMasterBusBroadcastChannel } from '../../hooks/useMasterBusBroadcastChannel';

interface RecordProps {
  userId: string;
  clubId: string;
  onChange: () => void;
}

function StatsLiveRecord({ userId, clubId, onChange }: RecordProps) {
  useMasterBusBroadcastChannel({
    channelName: `member-record:${clubId.toLowerCase()}:${userId.toLowerCase()}`,
    event: 'record_changed',
    onPayload: onChange,
    // A reconnect covers commits missed while this subscription was away.
    onSubscriptionStatus: (status) => {
      if (status === 'SUBSCRIBED') onChange();
    },
  });
  return null;
}

/** Reuse the transaction's private invalidation; never subscribe to raw hand rows. */
export default function StatsLiveRecords({
  userId,
  clubIds,
  enabled,
  onChange,
}: {
  userId: string | undefined;
  clubIds: string[];
  enabled: boolean;
  onChange: () => void;
}) {
  if (!enabled || !userId) return null;
  return [...new Set(clubIds)].map((clubId) => (
    <StatsLiveRecord
      key={`${clubId}:${userId}`}
      clubId={clubId}
      userId={userId}
      onChange={onChange}
    />
  ));
}
