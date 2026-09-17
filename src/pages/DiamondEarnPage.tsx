import DiamondSpinsTabs from '../components/games/DiamondSpinsTabs';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import { supabase } from '../lib/supabase';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { reportError } from '../utils/errorReporter';
import styles from './diamondGames.module.css';

interface Guide {
  ok: true;
  daily_cap: number;
  daily_used: number;
  daily_remaining: number;
  monthly_remaining: number;
  frozen: boolean;
  referral_diamonds: number | null;
  referral_code: string | null;
  actions: Array<{
    key: string;
    diamonds: number;
    base_diamonds: number;
    max_per_day: number;
    category: string;
  }>;
}
const ACTIVITIES: Record<string, { label: string; description: string; href: string }> = {
  social_post: {
    label: 'Create A Post',
    description: 'Share A Hand, Result Or Thought In The Feed.',
    href: '/hub/social-media',
  },
  share_content: {
    label: 'Share Content',
    description: 'Use The Share Button To Share A Post, Hand Or Score Card Outside The App.',
    href: '/hub/social-media',
  },
  strategy_comment: {
    label: 'Discuss Strategy',
    description: 'Leave A Substantive Strategy Comment On A Hand Or Post.',
    href: '/hub/social-media',
  },
  reaction: {
    label: 'React To A Post',
    description: 'React To Different Posts In The Feed.',
    href: '/hub/social-media',
  },
  follow: {
    label: 'Follow A Player',
    description: 'Find And Follow Players You Want To Hear From.',
    href: '/hub/social-media',
  },
  video_watch: {
    label: 'Watch A Video',
    description: 'Watch An Eligible Poker Video To Completion.',
    href: '/hub/video-library',
  },
  video_favorite: {
    label: 'Save A Favorite',
    description: 'Favorite A Poker Video You Want To Revisit.',
    href: '/hub/video-library',
  },
  training_level_complete: {
    label: 'Complete Training',
    description: 'Finish An Eligible Training Level.',
    href: '/hub/training',
  },
  gto_chart_study: {
    label: 'Study A Chart',
    description: 'Complete An Eligible GTO Chart Study Session.',
    href: '/hub/training/preflop-charts',
  },
  daily_trivia_challenge: {
    label: 'Daily Trivia',
    description: 'Complete The Daily Trivia Challenge.',
    href: '/hub/trivia',
  },
};
export default function DiamondEarnPage() {
  const { user } = useAuthUser();
  const { clubId } = useParams();
  return <DiamondEarnGuide key={`${user?.id ?? ''}:${clubId ?? ''}`} />;
}
function DiamondEarnGuide() {
  const { clubId } = useParams();
  const { user } = useAuthUser();
  const navigate = useNavigate();
  const [guide, setGuide] = useState<Guide | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setGuide(null);
    setError(null);
    (async () => {
      const { data, error: rpcError } = await supabase.rpc('fn_diamond_spins_earn_guide' as never);
      if (rpcError) throw rpcError;
      const v = data as Guide;
      if (
        !v ||
        v.ok !== true ||
        !Array.isArray(v.actions) ||
        !Number.isInteger(v.daily_cap) ||
        v.daily_cap < 0 ||
        v.daily_cap > 150 ||
        !Number.isInteger(v.daily_used) ||
        v.daily_used < 0 ||
        typeof v.frozen !== 'boolean' ||
        !Number.isInteger(v.monthly_remaining) ||
        v.monthly_remaining < 0 ||
        (v.referral_diamonds !== null && v.referral_diamonds !== 500) ||
        (v.referral_code !== null && typeof v.referral_code !== 'string') ||
        !Number.isFinite(v.daily_remaining) ||
        v.daily_remaining < 0 ||
        v.daily_remaining > v.daily_cap ||
        v.actions.some(
          (a) =>
            !ACTIVITIES[a.key] ||
            !Number.isFinite(a.diamonds) ||
            a.diamonds < 0 ||
            !Number.isSafeInteger(a.max_per_day)
        )
      )
        throw new Error('The Earning Guide Could Not Be Verified');
      if (!cancelled) setGuide(v);
    })().catch((e) => {
      reportError(e, 'DiamondEarnPage.load');
      if (!cancelled) setError('Your Earning Guide Could Not Be Loaded. Try Again.');
    });
    return () => {
      cancelled = true;
    };
  }, [user?.id, reload]);
  const copy = async () => {
    if (!guide?.referral_code) return;
    try {
      await navigator.clipboard.writeText(
        `https://smarter.poker/?ref=${encodeURIComponent(guide.referral_code)}`
      );
      setCopied(true);
    } catch (e) {
      reportError(e, 'DiamondEarnPage.copy');
      setError('Your Link Could Not Be Copied. Select The Link Below.');
    }
  };
  return (
    <div className={styles.page}>
      <button className={styles.back} onClick={() => navigate(`/clubs/${clubId}/wheel`)}>
        ‹ Diamond Spins
      </button>
      <DiamondSpinsTabs clubId={clubId ?? ''} />
      <SpadeConsole
        crest="diamond"
        title="Earn Diamonds"
        eyebrow="Your Daily Activities"
        pill={guide ? `${guide.daily_remaining} Left` : 'Loading'}
        plates={{ primary: { label: 'Refresh', onClick: () => setReload((n) => n + 1) } }}
      >
        <p className="sc-copy">
          Earn Up To 150 Diamonds A Day From Eligible Social, Video And Training Activities.
          Qualified Friend Referrals Sit Outside That Daily Cap.
        </p>
        {guide && (
          <p className="sc-copy">
            Your Daily Activity Limit: {guide.daily_cap} Diamonds. Earned Today: {guide.daily_used}.
            Resets At Midnight, Chicago Time.
          </p>
        )}
        {guide?.frozen && <p className="sc-copy">Diamond Rewards Are Paused Right Now.</p>}
        {guide && guide.monthly_remaining === 0 && (
          <p className="sc-copy">Your Monthly Activity Allowance Has Been Used.</p>
        )}
        {error && (
          <p className="sc-copy" role="alert">
            {error}
          </p>
        )}
      </SpadeConsole>
      {guide?.referral_diamonds && (
        <SpadeConsole
          crest="diamond"
          title="Refer A Friend"
          eyebrow={`${guide.referral_diamonds} Base Diamonds`}
          pill="No Daily Cap"
          plates={{
            primary: {
              label: copied ? 'Link Copied' : 'Copy Invite Link',
              onClick: () => void copy(),
              disabled: !guide.referral_code,
            },
          }}
        >
          <p className="sc-copy">
            Earn {guide.referral_diamonds} Base Diamonds When A Friend Qualifies. Referral Rewards
            Do Not Use Your Daily Activity Allowance.
          </p>
          <p className="sc-copy">
            Your Friend Must Verify Their Email And Phone, Have An Account At Least Seven Days Old,
            And Log In On Five Separate Days. Each Friend Qualifies Once. The Existing 20-Referral
            Monthly Limit Applies.
          </p>
          {guide.referral_code && (
            <label className={styles.seedField}>
              Your Invite Link
              <input
                className={styles.seedInput}
                readOnly
                value={`https://smarter.poker/?ref=${encodeURIComponent(guide.referral_code)}`}
                onFocus={(e) => e.target.select()}
              />
            </label>
          )}
        </SpadeConsole>
      )}
      {guide?.actions.map((action) => {
        const info = ACTIVITIES[action.key];
        return (
          <SpadeConsole
            key={action.key}
            crest="flat"
            title={info.label}
            eyebrow={`${action.diamonds} Diamonds Per Reward`}
            pill={`${action.max_per_day} Per Day`}
            plates={{
              primary: {
                label: 'Open Activity',
                onClick: () => {
                  window.location.href = `https://smarter.poker${info.href}`;
                },
              },
            }}
          >
            <p className="sc-copy">{info.description}</p>
            <p className="sc-copy">
              Subject To Your Remaining Activity Allowance. Repeat Actions On The Same Content Do
              Not Earn Again.{' '}
              {action.category === 'social'
                ? 'Social Rewards Require A Verified Email And An Account At Least 24 Hours Old.'
                : ''}
            </p>
          </SpadeConsole>
        );
      })}
    </div>
  );
}
