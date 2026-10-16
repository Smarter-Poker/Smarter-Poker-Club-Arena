import { useEffect, useRef, useState } from 'react';
import {
  readRotatingBanners,
  MAX_ROTATING_BANNERS,
  type ClubRotatingBanner,
} from '../../utils/clubRotatingBanners';
import {
  saveClubRotatingBanners,
  uploadClubBannerImage,
  validateClubBanner,
  type ClubBannerRecord,
} from '../../services/ClubBannerService';
import { safeErrorMessage } from '../../utils/safeErrorMessage';
import { reportError } from '../../utils/errorReporter';
import { titleCase } from '../../utils/titleCase';
import { useToast } from '../common/Toast';

type Draft = ClubRotatingBanner & { file?: File; ready?: boolean };
export default function ClubRotatingBannerEditor({
  club,
  ownerId,
  onSaved,
}: {
  club: ClubBannerRecord;
  ownerId: string;
  onSaved: (club: ClubBannerRecord) => void;
}) {
  const snapshot = JSON.stringify(club.settings ?? null);
  const [draft, setDraft] = useState<Draft[]>(() => readRotatingBanners(club.settings, club.id));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const live = useRef(true);
  const previews = useRef(new Set<string>());
  const uploads = useRef(new Map<string, string>());
  const toast = useToast();
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      previews.current.forEach(URL.revokeObjectURL);
    };
  }, []);
  useEffect(() => {
    setDraft(readRotatingBanners(JSON.parse(snapshot), club.id));
    previews.current.forEach(URL.revokeObjectURL);
    previews.current.clear();
    uploads.current.clear();
    setError('');
  }, [snapshot, club.id]);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(readRotatingBanners(club.settings, club.id));
  const change = (id: string, patch: Partial<Draft>) =>
    setDraft((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const save = async () => {
    if (busy.current || !dirty || draft.some((row) => row.file && !row.ready)) return;
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      const next: ClubRotatingBanner[] = [];
      for (const row of draft) {
        let imageUrl = row.imageUrl;
        if (row.file) {
          imageUrl =
            uploads.current.get(row.id) || (await uploadClubBannerImage(club.id, row.file));
          uploads.current.set(row.id, imageUrl);
        }
        if (!live.current) return;
        next.push({ id: row.id, title: row.title.trim(), imageUrl, enabled: row.enabled });
      }
      const saved = await saveClubRotatingBanners(club.id, ownerId, JSON.parse(snapshot), next);
      if (!live.current) return;
      onSaved(saved);
      toast.success('Rotating Banners Saved');
    } catch (failure) {
      reportError(failure, 'ClubRotatingBannerEditor.save');
      if (live.current)
        setError(safeErrorMessage(failure, 'Could Not Confirm Rotating Banner Save'));
    } finally {
      busy.current = false;
      if (live.current) setSaving(false);
    }
  };
  return (
    <section aria-label="Rotating Banners" aria-busy={saving}>
      <h2>Rotating Banners</h2>
      <p>
        Add Up To Three Club Banners. Enabled Banners Rotate First In This Order, Including In Union
        Clubs. Platform Promotions Fill Unused Spaces. Banner Taps Open Club Announcements.
      </p>
      {error && <p role="alert">{titleCase(error)}</p>}
      {!draft.length && <p>No Club Banners Added. Platform Promotions Continue To Display.</p>}
      {draft.map((row, index) => (
        <div key={row.id}>
          <h3>Banner {index + 1}</h3>
          <img
            className="club-banner-preview"
            src={row.imageUrl}
            alt={`Rotating Banner ${index + 1} Preview`}
            onLoad={() => {
              if (row.file && !row.ready) change(row.id, { ready: true });
            }}
            onError={() => {
              if (row.file) change(row.id, { ready: false });
              setError('Banner Image Could Not Be Loaded. Remove It And Choose Another Image.');
            }}
          />
          <label htmlFor={`rotating-title-${row.id}`}>Banner Title {index + 1}</label>
          <input
            id={`rotating-title-${row.id}`}
            value={row.title}
            maxLength={80}
            disabled={saving}
            onChange={(event) => change(row.id, { title: event.target.value })}
          />
          <label>
            <input
              type="checkbox"
              checked={row.enabled}
              disabled={saving}
              onChange={(event) => change(row.id, { enabled: event.target.checked })}
            />{' '}
            Enable Banner {index + 1}
          </label>
          <button
            type="button"
            disabled={saving || index === 0}
            aria-label={`Move Banner ${index + 1} Up`}
            onClick={() =>
              setDraft((rows) => {
                const next = [...rows];
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                return next;
              })
            }
          >
            Move Up
          </button>
          <button
            type="button"
            disabled={saving || index === draft.length - 1}
            aria-label={`Move Banner ${index + 1} Down`}
            onClick={() =>
              setDraft((rows) => {
                const next = [...rows];
                [next[index], next[index + 1]] = [next[index + 1], next[index]];
                return next;
              })
            }
          >
            Move Down
          </button>
          <button
            type="button"
            disabled={saving}
            aria-label={`Remove Banner ${index + 1}`}
            onClick={() => setDraft((rows) => rows.filter((other) => other.id !== row.id))}
          >
            Remove
          </button>
        </div>
      ))}
      <label htmlFor="rotating-banner-file">Add Rotating Banner Image</label>
      <input
        id="rotating-banner-file"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        disabled={saving || draft.length >= MAX_ROTATING_BANNERS}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file || busy.current || draft.length >= MAX_ROTATING_BANNERS) return;
          try {
            validateClubBanner(file);
            const imageUrl = URL.createObjectURL(file);
            previews.current.add(imageUrl);
            setDraft((rows) => [
              ...rows,
              {
                id: crypto.randomUUID(),
                title: `Club Banner ${rows.length + 1}`,
                imageUrl,
                enabled: true,
                file,
                ready: false,
              },
            ]);
            setError('');
          } catch (failure) {
            setError(safeErrorMessage(failure, 'Choose A Valid Image'));
          }
        }}
      />
      <p>
        JPEG, PNG, Or WebP. Maximum 2 MB. Recommended Shape Is Six Times Wider Than Tall. Images
        Display In Full.
      </p>
      <button
        type="button"
        disabled={
          saving || !dirty || draft.some((row) => !row.title.trim() || (row.file && !row.ready))
        }
        onClick={() => void save()}
      >
        {saving ? 'Saving Rotating Banners' : 'Save Rotating Banners'}
      </button>
    </section>
  );
}
