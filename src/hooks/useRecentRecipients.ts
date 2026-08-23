import { useState, useEffect, useCallback } from 'react';

const MAX_RECENT = 5;

export function useRecentRecipients(
  userId: string | undefined,
  clubId: string | null,
  sourceWallet: string
) {
  const [recentIds, setRecentIds] = useState<string[]>([]);

  const storageKey =
    userId && clubId ? `recent_recipients_${userId}_${clubId}_${sourceWallet}` : null;

  useEffect(() => {
    if (!storageKey) return;
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        setRecentIds(JSON.parse(stored));
      }
    } catch (e) {
      // ignore
    }
  }, [storageKey]);

  const addRecipient = useCallback(
    (recipientId: string) => {
      if (!storageKey) return;
      setRecentIds((prev) => {
        const filtered = prev.filter((id) => id !== recipientId);
        const next = [recipientId, ...filtered].slice(0, MAX_RECENT);
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch (e) {
          // ignore
        }
        return next;
      });
    },
    [storageKey]
  );

  return { recentIds, addRecipient };
}
