/**
 * MARKETPLACE - Item Art
 * ═══════════════════════════════════════════════════════════════════════════
 * Approved product portraits upgrade the existing card slots in place.
 * Throwables use one transparent collection portrait assembled from the
 * actual in-game assets, so a buyer is never shown a single tomato or egg as
 * though it were a separate product.
 *
 * Art resolution is fail closed: approved catalog identities resolve to their
 * exact portrait, while unknown or failed media renders the Marketplace's
 * identity-neutral chrome bay. A missing image must never invent product art.
 */

import { useId, useState } from 'react';
import styles from '../MarketplacePage.module.css';

const THROWABLE_COLLECTION_ART = `${import.meta.env.BASE_URL}images/marketplace/throwables/all-throwables-access-v1.png`;

/**
 * The World Hub already publishes the approved photoreal Club Shop product
 * portraits. Reuse those exact card crops in Club Arena instead of drawing a
 * second, generic icon set. The absolute URL also works when Club Arena is
 * inspected at its direct static origin rather than through the Hub rewrite.
 */
const CLUB_PRODUCT_ATLAS = 'https://smarter.poker/images/store-v3/club-shop-product-atlas-v2.webp';

const CLUB_PRODUCT_ATLAS_POSITIONS: Readonly<Record<string, string>> = {
  'vip rail seat 7 days': '0% 0%',
  '30s time bank': '33.333% 0%',
  'time bank 30s': '33.333% 0%',
  'time bank 60s': '33.333% 0%',
  'time bank bundle 5x': '66.667% 0%',
  'time bank bundle 100s': '66.667% 0%',
  'midnight felt table skin': '66.667% 50%',
  'royal gold table skin': '100% 50%',
  'classic emote pack': '0% 100%',
  'premium emote pack': '33.333% 100%',
  'shark avatar': '66.667% 100%',
  'crown avatar': '100% 100%',
  'royal monarch avatar': '100% 100%',
};

const CLUB_PRODUCT_ATLAS_REFS: Readonly<Record<string, string>> = {
  'carbon-ion': '66.667% 50%',
  midnight_felt: '66.667% 50%',
  midnight_a: '66.667% 50%',
  'rustic-wood': '100% 50%',
  royal_gold: '100% 50%',
  'free-animal-001': '66.667% 100%',
  shark: '66.667% 100%',
  'vip-people-007': '100% 100%',
  crown: '100% 100%',
};

export interface ItemArtIdentity {
  name?: string | null;
  category?: string | null;
  itemType?: string | null;
  grantType?: string | null;
  artRef?: string | null;
}

function normalizedArtKey(value?: string | null): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isThrowableIdentity(identity: ItemArtIdentity): boolean {
  return [identity.category, identity.itemType, identity.grantType].some((value) =>
    normalizedArtKey(value).includes('throw')
  );
}

function atlasPositionFor(identity: ItemArtIdentity): string | undefined {
  const ref = String(identity.artRef || '')
    .trim()
    .toLowerCase();
  return (
    CLUB_PRODUCT_ATLAS_REFS[ref] || CLUB_PRODUCT_ATLAS_POSITIONS[normalizedArtKey(identity.name)]
  );
}

export function hasCuratedItemArt(
  name?: string | null,
  category?: string | null,
  itemType?: string | null,
  grantType?: string | null,
  artRef?: string | null
): boolean {
  const identity = { name, category, itemType, grantType, artRef };
  return isThrowableIdentity(identity) || Boolean(atlasPositionFor(identity));
}

interface ItemArtProps {
  /** Category participates in approved art identity resolution. */
  category?: string | null;
  /** Product name selects an approved photoreal crop when one exists. */
  name?: string | null;
  /** Immutable catalog identity keeps approved art stable when display copy changes. */
  itemType?: string | null;
  grantType?: string | null;
  artRef?: string | null;
  /** Stable item key retained for existing call-site compatibility. */
  seed?: string;
  /** Fill the parent (card header) or render at a fixed square size. */
  size?: number | 'fill';
  className?: string;
}

type ArtStatus = 'loading' | 'unavailable';

/**
 * Existing neutral Club Arena bay used only while media is loading or when
 * verified product media is unavailable. It deliberately carries no item icon
 * or category illustration, so it cannot be mistaken for the product sold.
 */
function NeutralArtState({ status }: { status: ArtStatus }) {
  const unavailable = status === 'unavailable';
  return (
    <span className={styles.itemArtUnavailable} data-art-state={status}>
      <span className={styles.itemArtUnavailableFrame}>
        <span className={styles.itemArtUnavailableTitle}>
          {unavailable ? 'Artwork Unavailable' : 'Loading Verified Artwork'}
        </span>
        <span className={styles.itemArtUnavailableNote}>
          {unavailable ? 'Verified Image Required' : 'Checking Approved Media'}
        </span>
      </span>
    </span>
  );
}

/** Card and modal artwork for a Club Shop item. */
export default function ItemArt({
  category,
  name,
  itemType,
  grantType,
  artRef,
  size = 'fill',
  className,
}: ItemArtProps) {
  const [throwableArtFailed, setThrowableArtFailed] = useState(false);
  const [atlasState, setAtlasState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const identity = { name, category, itemType, grantType, artRef };
  const style =
    size === 'fill'
      ? { width: '100%', height: '100%', display: 'block' as const }
      : { width: size, height: (size * 3) / 4, display: 'block' as const };

  if (isThrowableIdentity(identity)) {
    return (
      <span aria-hidden="true" className={className} style={{ ...style, overflow: 'hidden' }}>
        {throwableArtFailed ? (
          <NeutralArtState status="unavailable" />
        ) : (
          <img
            src={THROWABLE_COLLECTION_ART}
            alt=""
            draggable={false}
            decoding="async"
            className={styles.throwableCollectionArt}
            onError={() => setThrowableArtFailed(true)}
          />
        )}
      </span>
    );
  }

  const atlasPosition = atlasPositionFor(identity);
  if (atlasPosition) {
    return (
      <span aria-hidden="true" className={className} style={{ ...style, overflow: 'hidden' }}>
        <span className={styles.itemArtMediaLayer}>
          {atlasState !== 'ready' && (
            <NeutralArtState status={atlasState === 'failed' ? 'unavailable' : 'loading'} />
          )}
          <img
            src={CLUB_PRODUCT_ATLAS}
            alt=""
            aria-hidden="true"
            draggable={false}
            className={styles.itemArtProbe}
            onLoad={() => setAtlasState('ready')}
            onError={() => setAtlasState('failed')}
          />
          {atlasState === 'ready' && (
            <span
              aria-hidden="true"
              className={styles.itemArtAtlasCrop}
              style={{
                backgroundImage: `url("${CLUB_PRODUCT_ATLAS}")`,
                backgroundPosition: atlasPosition,
              }}
            />
          )}
        </span>
      </span>
    );
  }

  return (
    <span aria-hidden="true" className={className} style={style}>
      <NeutralArtState status="unavailable" />
    </span>
  );
}

/* ─── Diamond package artwork (Diamonds tab) ─── */

function Stage({ ids, glow }: { ids: string; glow: string }) {
  return (
    <>
      <radialGradient id={`${ids}-stage`} cx="50%" cy="38%" r="72%">
        <stop offset="0%" stopColor="#22344a" />
        <stop offset="55%" stopColor="#131e2e" />
        <stop offset="100%" stopColor="#0a1018" />
      </radialGradient>
      <radialGradient id={`${ids}-halo`} cx="50%" cy="42%" r="46%">
        <stop offset="0%" stopColor={glow} />
        <stop offset="100%" stopColor="rgba(0,0,0,0)" />
      </radialGradient>
      <radialGradient id={`${ids}-floor`} cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="rgba(0,0,0,0.55)" />
        <stop offset="100%" stopColor="rgba(0,0,0,0)" />
      </radialGradient>
    </>
  );
}

function SceneBase({ ids }: { ids: string }) {
  return (
    <>
      <rect width="200" height="150" fill={`url(#${ids}-stage)`} />
      <rect width="200" height="150" fill={`url(#${ids}-halo)`} />
      <ellipse cx="100" cy="126" rx="58" ry="11" fill={`url(#${ids}-floor)`} />
    </>
  );
}

export function DiamondArt({
  tier = 0,
  className,
}: {
  /** 0..7 package index: bigger tiers get bigger, brighter stones. */
  tier?: number;
  className?: string;
}) {
  const ids = useId().replace(/[^a-zA-Z0-9]/g, '');
  const scale = 0.72 + Math.min(tier, 7) * 0.05;
  const extra = tier >= 5;
  return (
    <svg
      viewBox="0 0 200 150"
      preserveAspectRatio="xMidYMid slice"
      style={{ width: '100%', height: '100%', display: 'block' }}
      className={className}
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <Stage ids={ids} glow="rgba(0, 212, 255, 0.55)" />
        <linearGradient id={`${ids}-gemTop`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e0f7ff" />
          <stop offset="100%" stopColor="#38bdf8" />
        </linearGradient>
        <linearGradient id={`${ids}-gemBody`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7dd3fc" />
          <stop offset="55%" stopColor="#0ea5e9" />
          <stop offset="100%" stopColor="#1d4ed8" />
        </linearGradient>
      </defs>
      <SceneBase ids={ids} />
      <g transform={`translate(100 78) scale(${scale}) translate(-100 -78)`}>
        <path d="M62 62 L82 42 L118 42 L138 62 Z" fill={`url(#${ids}-gemTop)`} />
        <path d="M82 42 L100 62 L118 42 Z" fill="#bae6fd" />
        <path d="M62 62 L100 62 L82 42 Z" fill="#7dd3fc" />
        <path d="M138 62 L100 62 L118 42 Z" fill="#38bdf8" />
        <path d="M62 62 L100 116 L100 62 Z" fill={`url(#${ids}-gemBody)`} />
        <path d="M138 62 L100 116 L100 62 Z" fill="#0284c7" />
        <path d="M62 62 L100 116 L138 62 Z" fill="rgba(255,255,255,0.08)" />
        <path d="M86 46 L94 46 L78 60 L70 60 Z" fill="rgba(255,255,255,0.75)" />
        <circle cx="100" cy="80" r="2.4" fill="rgba(255,255,255,0.7)" />
      </g>
      {extra && (
        <g fill="#7dd3fc" opacity="0.95">
          <path d="M52 44 l2.4 6 6 2.4 -6 2.4 -2.4 6 -2.4 -6 -6 -2.4 6 -2.4 z" />
          <path d="M150 96 l1.8 4.6 4.6 1.8 -4.6 1.8 -1.8 4.6 -1.8 -4.6 -4.6 -1.8 4.6 -1.8 z" />
        </g>
      )}
    </svg>
  );
}
