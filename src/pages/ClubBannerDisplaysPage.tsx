import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import { SpadeConsole } from '../components/console/SpadeConsole';
import StandardContentLayout from '../components/layouts/StandardContentLayout';
import { useToast } from '../components/common/Toast';
import { resolveClubUUIDStrict } from '../utils/clubIdResolver';
import { titleCase } from '../utils/titleCase';
import { mediaUrl } from '../utils/mediaBase';
import { reportError } from '../utils/errorReporter';
import { safeErrorMessage } from '../utils/safeErrorMessage';
import {
  readClubBanner,
  saveClubBanner,
  uploadClubBannerImage,
  validateClubBanner,
  type ClubBannerRecord,
} from '../services/ClubBannerService';
import ClubAdVisibilityControl from '../components/club/ClubAdVisibilityControl';
import './ClubBannerDisplaysPage.css';

const DEFAULT_BANNER = mediaUrl(
  'assets/club-buttons/lobby/shark-club-championship-ad-mobile-v4.png'
);

export default function ClubBannerDisplaysPage() {
  const { clubId } = useParams<{ clubId: string }>();
  const { user } = useAuthUser();
  return <BannerEditor key={`${user?.id}:${clubId}`} clubId={clubId} userId={user?.id} />;
}

function BannerEditor({ clubId, userId }: { clubId?: string; userId?: string }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [club, setClub] = useState<ClubBannerRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [imageReady, setImageReady] = useState(false);
  const [useDefault, setUseDefault] = useState(false);
  const mounted = useRef(false);
  const busy = useRef(false);
  const uploaded = useRef<{ file: File; url: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const isOwner = Boolean(club && userId && club.owner_id === userId);
  const dirty = Boolean(file || (useDefault && club?.banner_url));

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setClub(null);
    setError('');
    setFile(null);
    setUseDefault(false);
    uploaded.current = null;
    void (async () => {
      try {
        if (!clubId || !userId) throw new Error('Sign In And Select A Club');
        const id = await resolveClubUUIDStrict(clubId);
        const record = await readClubBanner(id);
        if (live) setClub(record);
      } catch (failure) {
        reportError(failure, 'ClubBannerDisplays.load');
        if (live) setError(safeErrorMessage(failure, 'Could Not Load Banner Displays'));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [clubId, userId, reload]);
  useEffect(() => {
    if (!file) {
      setPreview('');
      setImageReady(false);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    setImageReady(false);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const save = async () => {
    if (!club || !isOwner || !userId || !dirty || busy.current || (file && !imageReady)) return;
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      let next: string | null = null;
      if (file) {
        if (uploaded.current?.file !== file)
          uploaded.current = { file, url: await uploadClubBannerImage(club.id, file) };
        next = uploaded.current.url;
      }
      if (!mounted.current) return;
      const saved = await saveClubBanner(club.id, userId, club.banner_url, next);
      if (!mounted.current) return;
      setClub((current) => (current ? { ...current, banner_url: saved.banner_url } : saved));
      setFile(null);
      setUseDefault(false);
      uploaded.current = null;
      if (input.current) input.current.value = '';
      toast.success('Banner Display Saved');
    } catch (failure) {
      reportError(failure, 'ClubBannerDisplays.save');
      if (mounted.current) setError(safeErrorMessage(failure, 'Could Not Confirm Banner Save'));
    } finally {
      busy.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <StandardContentLayout className="club-banner-page">
      <SpadeConsole
        eyebrow={club ? titleCase(club.name) : 'Club Operations'}
        title="Banner Displays"
        subtitle="Your Club Lobby Promotion"
        plates={{
          secondary: {
            label: 'Back To Club',
            onClick: () => navigate(`/clubs/${clubId}`),
            disabled: saving,
          },
          primary: {
            label: saving ? 'Saving' : 'Save Banner',
            onClick: () => void save(),
            disabled: loading || saving || !isOwner || !dirty || Boolean(file && !imageReady),
          },
        }}
      >
        <div className="club-banner-body" aria-busy={loading || saving}>
          {loading && <p role="status">Loading Banner Displays...</p>}
          {error && <p role="alert">{titleCase(error)}</p>}
          {!loading && !isOwner && club && <p>Only The Club Owner Can Change Banner Displays.</p>}
          {!loading && isOwner && club && (
            <>
              <p>
                Manage Your Club Banner And Smarter.Poker Ad Visibility, Including In Union Clubs.
              </p>
              <h2>Lobby Banner Preview</h2>
              <img
                className="club-banner-preview"
                src={preview || (useDefault ? DEFAULT_BANNER : club.banner_url || DEFAULT_BANNER)}
                alt="Club Lobby Banner Preview"
                onLoad={() => {
                  if (file) setImageReady(true);
                }}
                onError={() => {
                  setImageReady(false);
                  setError('The Image Could Not Be Loaded. Choose Another Image.');
                }}
              />
              <label htmlFor="club-banner-file">Choose Banner Image</label>
              <input
                ref={input}
                id="club-banner-file"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={saving}
                onChange={(event) => {
                  const selected = event.target.files?.[0];
                  if (!selected) return;
                  setError('');
                  try {
                    validateClubBanner(selected);
                    setImageReady(false);
                    setFile(selected);
                    setUseDefault(false);
                    uploaded.current = null;
                  } catch (failure) {
                    setError(safeErrorMessage(failure, 'Choose A Valid Image'));
                    event.target.value = '';
                  }
                }}
              />
              <p>
                JPEG, PNG, Or WebP. Maximum 2 MB. Use A Wide Image With Text Away From The Edges.
                Preview Shows The Full Image.
              </p>
              <button
                type="button"
                disabled={saving || (!file && !club.banner_url)}
                onClick={() => {
                  setFile(null);
                  setUseDefault(true);
                  setError('');
                  uploaded.current = null;
                  if (input.current) input.current.value = '';
                }}
              >
                Use Default Banner
              </button>
              <p>Banner Taps Open Your Club Announcements.</p>
              <ClubAdVisibilityControl
                club={club}
                ownerId={userId!}
                onSaved={(saved) =>
                  setClub((current) => (current ? { ...current, settings: saved.settings } : saved))
                }
              />
            </>
          )}
          {!loading && (
            <button type="button" disabled={saving} onClick={() => setReload((value) => value + 1)}>
              Reload
            </button>
          )}
        </div>
      </SpadeConsole>
    </StandardContentLayout>
  );
}
