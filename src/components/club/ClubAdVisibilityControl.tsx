import { useEffect, useRef, useState } from 'react';
import { saveClubAdVisibility, type ClubBannerRecord } from '../../services/ClubBannerService';
import { safeErrorMessage } from '../../utils/safeErrorMessage';
import { reportError } from '../../utils/errorReporter';
import { titleCase } from '../../utils/titleCase';
import { useToast } from '../common/Toast';

export default function ClubAdVisibilityControl({
  club,
  ownerId,
  onSaved,
}: {
  club: ClubBannerRecord;
  ownerId: string;
  onSaved: (club: ClubBannerRecord) => void;
}) {
  const snapshot = JSON.stringify(club.settings ?? null);
  const savedVisible = club.settings?.show_smarter_poker_ads !== false;
  const [visible, setVisible] = useState(savedVisible);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const live = useRef(true);
  const toast = useToast();
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    setVisible(
      (JSON.parse(snapshot) as Record<string, unknown> | null)?.show_smarter_poker_ads !== false
    );
    setError('');
  }, [snapshot, club.id]);
  const save = async () => {
    if (busy.current || visible === savedVisible) return;
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      const saved = await saveClubAdVisibility(club.id, ownerId, JSON.parse(snapshot), visible);
      if (!live.current) return;
      onSaved(saved);
      toast.success('Ad Visibility Saved');
    } catch (failure) {
      reportError(failure, 'ClubAdVisibilityControl.save');
      if (live.current) setError(safeErrorMessage(failure, 'Could Not Confirm Ad Visibility Save'));
    } finally {
      busy.current = false;
      if (live.current) setSaving(false);
    }
  };
  return (
    <section aria-label="Smarter.Poker Rotating Ads" aria-busy={saving}>
      <h2>Smarter.Poker Rotating Ads</h2>
      <p>
        Choose Whether To Show Smarter.Poker Ads Below Your Club Banner, Including In Union Clubs.
        Ad Content Is Managed By Smarter.Poker.
      </p>
      {error && <p role="alert">{titleCase(error)}</p>}
      <label>
        <input
          type="checkbox"
          role="switch"
          checked={visible}
          disabled={saving}
          onChange={(event) => setVisible(event.target.checked)}
        />
        Show Smarter.Poker Rotating Ads
      </label>
      <button
        type="button"
        disabled={saving || visible === savedVisible}
        onClick={() => void save()}
      >
        {saving ? 'Saving Ad Visibility' : 'Save Ad Visibility'}
      </button>
    </section>
  );
}
