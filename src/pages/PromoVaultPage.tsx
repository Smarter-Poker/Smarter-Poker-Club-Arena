/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PROMO VAULT - Requirement 6
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-23:
 *   "next is 'backpack' in reference image, but call it the 'Promo Vault' on
 *    smarter.poker. Union and club owners can buy features, VIP cards and all
 *    other things from the marketplace with their diamonds, store them here,
 *    and send them to any player."
 *
 * THE SHAPE, FROM THE REFERENCE. Two tabs, Items and Records. Items opens on a
 * hint line, then a Features section and a VIP Cards section, each a grid of
 * tiles carrying a quantity badge and a plus control to buy more. Records is the
 * history: what was bought, what was sent out, and to whom. A help control
 * explains the one thing the screen cannot show by itself -- that an item sits
 * on the shelf until you choose to send it.
 *
 * WHY A TILE DOES TWO DIFFERENT THINGS. The plus buys; the tile itself grants.
 * That is the reference's own division and it is the right one: buying spends
 * the club's diamonds and touches nobody, granting spends nothing and touches a
 * named player. Merging them into one tap would make the more dangerous action
 * the easier one. A tile holding zero cannot be granted from, so tapping it
 * points at the plus instead of opening a picker onto an empty shelf.
 *
 * WHY THE ROSTER LOADS ON MOUNT AND NOT WHEN THE PICKER OPENS. It answers two
 * questions, not one: who can be sent to, and what the person reading is
 * allowed to do. The viewer's own role comes out of the same array, so the
 * read-only variant of this screen costs no extra round trip -- and the picker
 * opens instantly rather than showing a spinner over a modal.
 *
 * NO GREEN AND NO PURPLE, per the same instruction that rebuilt the Players tab
 * today. Arena cyan for features, the three VIP tiers in bronze, club blue and
 * gold, and diamonds in cyan throughout. Every user-visible string is Title
 * Case, and every message to the user goes through the Toast layer.
 *
 * NOTHING IS WRITTEN FROM HERE. The three vault tables grant SELECT to clients
 * and nothing else; ca_promo_vault_buy and ca_promo_vault_grant are SECURITY
 * DEFINER and carry the role check, the balance check and the ledger write
 * together. This page is a view over them, so a hostile client gains nothing by
 * calling them differently.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import PageSkeleton from '../components/common/PageSkeleton';
import { ErrorState } from '../components/common/EmptyState';
import RoleBadge from '../components/club/RoleBadge';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';
import { toTitleCase } from '../utils/titleCase';
import { normaliseRole, type ClubRole } from '../types/clubRoles';
import ClubRosterService, { type RosterMember } from '../services/ClubRosterService';
import './PromoVaultPage.css';

/* ═══════════════════════════════════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════════════════════════════════ */

interface VaultItem {
  item_key: string;
  category: 'feature' | 'vip_card';
  label: string;
  description: string | null;
  duration_days: number | null;
  pack_size: number | null;
  tier: string | null;
  diamond_cost: number;
  icon_key: string | null;
  sort_order: number;
  quantity: number;
}

interface VaultRecord {
  id: string;
  created_at: string;
  action: 'purchase' | 'grant' | 'revoke';
  item_key: string;
  item_label: string;
  quantity: number;
  diamonds_spent: number;
  actor_name: string | null;
  recipient_name: string | null;
  recipient_player_number: string | null;
  note: string | null;
}

/** PostgREST hands `numeric` back as a string. Make it a number, exactly once. */
function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Diamonds, quantities and costs all read the same way. Never padStart. */
function count(value: number): string {
  return (value ?? 0).toLocaleString();
}

/**
 * Unicode geometry, never emoji -- emoji break the SWC compiler (code safety
 * rule 3) and render differently on every platform. An unknown key still gets a
 * mark rather than an empty tile.
 */
const ITEM_GLYPH: Record<string, string> = {
  'time-bank': '◔',
  'rabbit-hunt': '◈',
  'mystery-card': '◇',
  multiplier: '×',
  'vip-bronze': '▣',
  'vip-sapphire': '▣',
  'vip-gold': '▣',
};

/** Bronze, club blue and gold. No green, no purple. */
const TIER_COLOR: Record<string, string> = {
  bronze: '#C88A4A',
  sapphire: '#4169E1',
  gold: '#FFC93C',
};

function itemColor(item: VaultItem): string {
  if (item.category === 'vip_card' && item.tier) return TIER_COLOR[item.tier] ?? '#00D4FF';
  return '#00D4FF';
}

/**
 * The line under a tile's name. A Time Bank pack has a size and no duration, a
 * Mystery Card a duration and no size, and the multiplier carries both -- so
 * whichever parts exist are joined rather than assumed.
 */
function itemMeta(item: VaultItem): string {
  const parts: string[] = [];
  if (item.pack_size) parts.push(`x${item.pack_size.toLocaleString()}`);
  if (item.duration_days) parts.push(`${item.duration_days.toLocaleString()} Days`);
  return parts.join(' · ');
}

const ACTION_LABEL: Record<VaultRecord['action'], string> = {
  purchase: 'Bought',
  grant: 'Sent Out',
  revoke: 'Taken Back',
};

const MANAGER_ROLES: ClubRole[] = ['owner', 'co_owner', 'admin'];

/* ═══════════════════════════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════════════════════════ */

export default function PromoVaultPage() {
  const { clubId: routeClubId } = useParams();
  const [searchParams] = useSearchParams();
  const clubId = routeClubId || searchParams.get('club') || undefined;
  const preselectedPlayer = searchParams.get('player');
  const { user } = useAuthUser();
  const toast = useToast();
  const navigate = useNavigate();
  const isMountedRef = useIsMounted();

  const [resolvedClubId, setResolvedClubId] = useState<string | null>(null);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [records, setRecords] = useState<VaultRecord[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [diamonds, setDiamonds] = useState(0);
  const [userRole, setUserRole] = useState<ClubRole>('player');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [tab, setTab] = useState<'items' | 'records'>('items');
  const [helpOpen, setHelpOpen] = useState(false);
  const [buyTarget, setBuyTarget] = useState<VaultItem | null>(null);
  const [grantTarget, setGrantTarget] = useState<VaultItem | null>(null);

  const recordsLoadedRef = useRef(false);

  const canManage = MANAGER_ROLES.includes(userRole);

  // Safety net: an empty vault is a better answer than a skeleton that never
  // resolves, if auth or the network hangs.
  useEffect(() => {
    const timeout = setTimeout(() => setLoading(false), 8000);
    return () => clearTimeout(timeout);
  }, []);

  /* ── Load ─────────────────────────────────────────────────────────────── */

  const loadVault = useCallback(
    async (getIsMounted?: () => boolean) => {
      if (!clubId) return;
      const live = () => (getIsMounted ? getIsMounted() : true) && isMountedRef.current;

      if (live()) setLoading(true);
      if (live()) setLoadError(null);
      try {
        const uuid = await resolveClubUUID(clubId);
        if (!live()) return;
        if (!uuid) {
          setItems([]);
          return;
        }
        setResolvedClubId(uuid);

        // The catalog already carries this club's holdings, so the shelf and the
        // price list are one round trip rather than two and a join in the
        // browser. The wallet and the roster ride alongside it.
        const [catalogResult, walletResult, rosterResult] = await Promise.allSettled([
          supabase.rpc('ca_promo_vault_catalog', { p_club_id: uuid }),
          supabase.from('club_diamond_wallets').select('balance').eq('club_id', uuid).maybeSingle(),
          ClubRosterService.getRoster(uuid),
        ]);
        if (!live()) return;

        if (catalogResult.status === 'fulfilled') {
          const { data, error } = catalogResult.value;
          if (error) throw error;
          setItems(
            ((data ?? []) as Record<string, unknown>[]).map((row) => ({
              item_key: String(row.item_key ?? ''),
              category: (row.category as VaultItem['category']) ?? 'feature',
              label: (row.label as string) ?? '',
              description: (row.description as string) ?? null,
              duration_days: row.duration_days == null ? null : num(row.duration_days),
              pack_size: row.pack_size == null ? null : num(row.pack_size),
              tier: (row.tier as string) ?? null,
              diamond_cost: num(row.diamond_cost),
              icon_key: (row.icon_key as string) ?? null,
              sort_order: num(row.sort_order),
              quantity: num(row.quantity),
            }))
          );
        } else {
          throw catalogResult.reason;
        }

        // A club with no wallet row yet shows zero rather than an error: the
        // vault is still perfectly readable, buying is simply refused.
        if (walletResult.status === 'fulfilled') {
          setDiamonds(num(walletResult.value.data?.balance));
        }

        if (rosterResult.status === 'fulfilled') {
          const list = rosterResult.value;
          setRoster(list);
          if (user?.id) {
            const me = list.find((m) => m.user_id === user.id);
            if (me) setUserRole(me.role);
            else {
              const { data: memberData } = await supabase
                .from('club_members')
                .select('role')
                .eq('club_id', uuid)
                .eq('user_id', user.id)
                .maybeSingle();
              if (live() && memberData) setUserRole(normaliseRole(memberData.role));
            }
          }
        } else {
          reportError(rosterResult.reason, 'PromoVaultPage.roster');
        }
      } catch (error) {
        reportError(error, 'PromoVaultPage.loadVault');
        if (live()) {
          setLoadError('The live vault catalog could not be loaded. No diamonds were spent.');
          toast.error('Failed To Load The Promo Vault');
        }
      } finally {
        if (live()) setLoading(false);
      }
    },
    [clubId, user?.id, isMountedRef, toast]
  );

  useEffect(() => {
    let mounted = true;
    if (clubId) loadVault(() => mounted);
    return () => {
      mounted = false;
    };
  }, [clubId, loadVault]);

  const loadRecords = useCallback(async () => {
    if (!resolvedClubId) return;
    setRecordsLoading(true);
    try {
      const { data, error } = await supabase.rpc('ca_promo_vault_records', {
        p_club_id: resolvedClubId,
        p_limit: 100,
      });
      if (error) throw error;
      if (!isMountedRef.current) return;
      setRecords(
        ((data ?? []) as Record<string, unknown>[]).map((row) => ({
          id: String(row.id ?? ''),
          created_at: (row.created_at as string) ?? '',
          action: (row.action as VaultRecord['action']) ?? 'purchase',
          item_key: String(row.item_key ?? ''),
          item_label: (row.item_label as string) ?? '',
          quantity: num(row.quantity),
          diamonds_spent: num(row.diamonds_spent),
          actor_name: (row.actor_name as string) ?? null,
          recipient_name: (row.recipient_name as string) ?? null,
          recipient_player_number: (row.recipient_player_number as string) ?? null,
          note: (row.note as string) ?? null,
        }))
      );
      recordsLoadedRef.current = true;
    } catch (error) {
      reportError(error, 'PromoVaultPage.loadRecords');
      if (isMountedRef.current) toast.error('Failed To Load The Vault Records');
    } finally {
      if (isMountedRef.current) setRecordsLoading(false);
    }
  }, [resolvedClubId, isMountedRef, toast]);

  // Records are the second tab and most sessions never open it, so they are
  // fetched the first time it is asked for rather than on every page load.
  useEffect(() => {
    if (tab === 'records' && resolvedClubId && !recordsLoadedRef.current) {
      void loadRecords();
    }
  }, [tab, resolvedClubId, loadRecords]);

  /* ── Buy ──────────────────────────────────────────────────────────────── */

  const handleBuy = useCallback(
    async (item: VaultItem, quantity: number) => {
      if (!resolvedClubId) return;
      try {
        const { data, error } = await supabase.rpc('ca_promo_vault_buy', {
          p_club_id: resolvedClubId,
          p_item_key: item.item_key,
          p_quantity: quantity,
        });
        if (error) throw error;
        const result = (data ?? {}) as Record<string, unknown>;
        if (result.success !== true) {
          toast.error(String(result.error ?? 'That Purchase Could Not Be Completed'));
          return;
        }
        // The RPC returns the authoritative new numbers, so the screen updates
        // from the answer rather than guessing and re-fetching.
        setItems((prev) =>
          prev.map((i) =>
            i.item_key === item.item_key ? { ...i, quantity: num(result.quantity) } : i
          )
        );
        setDiamonds(num(result.diamond_balance));
        recordsLoadedRef.current = false;
        if (tab === 'records') void loadRecords();
        setBuyTarget(null);
        toast.success(
          `Bought ${count(quantity)} ${item.label} For ${count(num(result.diamonds_spent))} Diamonds`
        );
      } catch (err) {
        reportError(err, 'PromoVaultPage.handleBuy');
        toast.error('That Purchase Could Not Be Completed');
      }
    },
    [resolvedClubId, tab, loadRecords, toast]
  );

  /* ── Grant ────────────────────────────────────────────────────────────── */

  const handleGrant = useCallback(
    async (item: VaultItem, recipient: RosterMember, quantity: number) => {
      if (!resolvedClubId) return;
      try {
        const { data, error } = await supabase.rpc('ca_promo_vault_grant', {
          p_club_id: resolvedClubId,
          p_item_key: item.item_key,
          p_recipient_user_id: recipient.user_id,
          p_quantity: quantity,
          p_note: null,
        });
        if (error) throw error;
        const result = (data ?? {}) as Record<string, unknown>;
        if (result.success !== true) {
          toast.error(String(result.error ?? 'That Item Could Not Be Sent'));
          return;
        }
        setItems((prev) =>
          prev.map((i) =>
            i.item_key === item.item_key ? { ...i, quantity: num(result.remaining) } : i
          )
        );
        recordsLoadedRef.current = false;
        if (tab === 'records') void loadRecords();
        setGrantTarget(null);
        toast.success(`Sent ${count(quantity)} ${item.label} To ${recipient.alias}`);
      } catch (err) {
        reportError(err, 'PromoVaultPage.handleGrant');
        toast.error('That Item Could Not Be Sent');
      }
    },
    [resolvedClubId, tab, loadRecords, toast]
  );

  /* ── Sections ─────────────────────────────────────────────────────────── */

  const features = useMemo(() => items.filter((i) => i.category === 'feature'), [items]);
  const vipCards = useMemo(() => items.filter((i) => i.category === 'vip_card'), [items]);

  const openTile = useCallback(
    (item: VaultItem) => {
      if (item.quantity > 0) {
        setGrantTarget(item);
        return;
      }
      if (canManage) {
        setBuyTarget(item);
        return;
      }
      toast.info('The Vault Holds None Of This Item Yet');
    },
    [canManage, toast]
  );

  /* ── Render ───────────────────────────────────────────────────────────── */

  return (
    <div className="promo-vault-page">
      <header className="pv-header">
        <button
          type="button"
          className="pv-back"
          onClick={() => navigate(clubId ? `/clubs/${clubId}` : '/clubs')}
          aria-label="Go Back"
        >
          <span aria-hidden="true">‹</span>
        </button>

        <h1 className="pv-title">Promo Vault</h1>

        <div className="pv-header-right">
          <span className="pv-balance" title="Club Diamond Balance">
            <span className="pv-balance__glyph" aria-hidden="true">
              ◆
            </span>
            <span className="pv-balance__value">{count(diamonds)}</span>
            <span className="sr-only">Diamonds In The Club Wallet</span>
          </span>
          <button
            type="button"
            className="pv-help-button"
            onClick={() => setHelpOpen(true)}
            aria-label="How The Promo Vault Works"
          >
            ?
          </button>
        </div>
      </header>

      <div className="pv-tabs" role="tablist" aria-label="Promo Vault Sections">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'items'}
          className={tab === 'items' ? 'active' : ''}
          onClick={() => setTab('items')}
        >
          Items
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'records'}
          className={tab === 'records' ? 'active' : ''}
          onClick={() => setTab('records')}
        >
          Records
        </button>
      </div>

      {loading && items.length === 0 ? (
        <PageSkeleton variant="list" />
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={() => void loadVault()} />
      ) : tab === 'items' ? (
        <div className="pv-body">
          <p className="pv-hint">Click An Item To Grant</p>

          {!canManage && (
            <p className="pv-readonly">
              Only Owners And Admins Can Buy Or Send Items From This Vault.
            </p>
          )}

          <ItemSection
            heading="Features"
            items={features}
            canManage={canManage}
            onOpen={openTile}
            onBuy={setBuyTarget}
          />
          <ItemSection
            heading="VIP Cards"
            items={vipCards}
            canManage={canManage}
            onOpen={openTile}
            onBuy={setBuyTarget}
          />
        </div>
      ) : (
        <RecordsList records={records} loading={recordsLoading} />
      )}

      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}

      {buyTarget && (
        <BuyDialog
          item={buyTarget}
          diamonds={diamonds}
          onCancel={() => setBuyTarget(null)}
          onConfirm={handleBuy}
        />
      )}

      {grantTarget && (
        <GrantDialog
          item={grantTarget}
          roster={roster}
          canManage={canManage}
          preselectedPlayerId={preselectedPlayer}
          onCancel={() => setGrantTarget(null)}
          onConfirm={handleGrant}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ONE SECTION OF TILES
   ═══════════════════════════════════════════════════════════════════════════════ */

function ItemSection({
  heading,
  items,
  canManage,
  onOpen,
  onBuy,
}: {
  heading: string;
  items: VaultItem[];
  canManage: boolean;
  onOpen: (item: VaultItem) => void;
  onBuy: (item: VaultItem) => void;
}) {
  if (items.length === 0) return null;

  return (
    <section className="pv-section">
      <h2 className="pv-section__heading">{heading}</h2>
      <div className="pv-grid">
        {items.map((item) => (
          <ItemTile
            key={item.item_key}
            item={item}
            canManage={canManage}
            onOpen={onOpen}
            onBuy={onBuy}
          />
        ))}
      </div>
    </section>
  );
}

function ItemTile({
  item,
  canManage,
  onOpen,
  onBuy,
}: {
  item: VaultItem;
  canManage: boolean;
  onOpen: (item: VaultItem) => void;
  onBuy: (item: VaultItem) => void;
}) {
  const color = itemColor(item);
  const meta = itemMeta(item);

  return (
    <div
      className={`pv-tile${item.quantity > 0 ? ' pv-tile--held' : ''}`}
      style={{ '--tile-color': color } as React.CSSProperties}
    >
      <button
        type="button"
        className="pv-tile__face"
        onClick={() => onOpen(item)}
        aria-label={`Grant ${item.label}${meta ? `, ${meta}` : ''}`}
      >
        <span className="pv-tile__icon" aria-hidden="true">
          {ITEM_GLYPH[item.icon_key ?? ''] ?? '◇'}
        </span>
        {item.quantity > 0 && <span className="pv-tile__badge">{count(item.quantity)}</span>}
        <span className="pv-tile__label">{item.label}</span>
        {meta && <span className="pv-tile__meta">{meta}</span>}
      </button>

      <div className="pv-tile__foot">
        <span className="pv-tile__cost">
          <span className="pv-tile__cost-glyph" aria-hidden="true">
            ◆
          </span>
          {count(item.diamond_cost)}
        </span>
        {canManage && (
          <button
            type="button"
            className="pv-tile__plus"
            onClick={() => onBuy(item)}
            aria-label={`Buy More ${item.label}`}
          >
            +
          </button>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   BUY
   ═══════════════════════════════════════════════════════════════════════════════ */

function BuyDialog({
  item,
  diamonds,
  onCancel,
  onConfirm,
}: {
  item: VaultItem;
  diamonds: number;
  onCancel: () => void;
  onConfirm: (item: VaultItem, quantity: number) => Promise<void>;
}) {
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);

  const total = item.diamond_cost * quantity;
  const affordable = total <= diamonds;

  const step = (delta: number) => setQuantity((q) => Math.min(999, Math.max(1, q + delta)));

  return (
    <Overlay onClose={onCancel} labelledBy="pv-buy-title">
      <h2 id="pv-buy-title" className="pv-dialog__title">
        Buy {item.label}
      </h2>
      {itemMeta(item) && <p className="pv-dialog__sub">{itemMeta(item)}</p>}

      <div className="pv-stepper">
        <button type="button" onClick={() => step(-1)} aria-label="Fewer" disabled={quantity <= 1}>
          −
        </button>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={999}
          value={quantity}
          aria-label="Quantity To Buy"
          onChange={(e) => {
            const next = Number(e.target.value);
            setQuantity(Number.isFinite(next) ? Math.min(999, Math.max(1, Math.floor(next))) : 1);
          }}
        />
        <button type="button" onClick={() => step(1)} aria-label="More" disabled={quantity >= 999}>
          +
        </button>
      </div>

      <div className="pv-dialog__totals">
        <span>Total Cost</span>
        <span className={affordable ? 'pv-total' : 'pv-total pv-total--short'}>
          <span aria-hidden="true">◆</span> {count(total)}
        </span>
      </div>
      <div className="pv-dialog__totals pv-dialog__totals--quiet">
        <span>Club Balance</span>
        <span>
          <span aria-hidden="true">◆</span> {count(diamonds)}
        </span>
      </div>

      {!affordable && <p className="pv-dialog__warn">Not Enough Diamonds For This Purchase.</p>}

      <div className="pv-dialog__actions">
        <button type="button" className="pv-btn pv-btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="pv-btn pv-btn--primary"
          disabled={busy || !affordable}
          onClick={async () => {
            setBusy(true);
            await onConfirm(item, quantity);
            setBusy(false);
          }}
        >
          {busy ? 'Buying...' : 'Confirm'}
        </button>
      </div>
    </Overlay>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   GRANT - pick a player, then a quantity
   ═══════════════════════════════════════════════════════════════════════════════ */

function GrantDialog({
  item,
  roster,
  canManage,
  preselectedPlayerId,
  onCancel,
  onConfirm,
}: {
  item: VaultItem;
  roster: RosterMember[];
  canManage: boolean;
  preselectedPlayerId: string | null;
  onCancel: () => void;
  onConfirm: (item: VaultItem, recipient: RosterMember, quantity: number) => Promise<void>;
}) {
  // Arriving from a member's page with ?player= means the recipient is already
  // decided, so the picker is skipped and the dialog opens on the quantity.
  const preselected = useMemo(
    () =>
      preselectedPlayerId ? (roster.find((m) => m.user_id === preselectedPlayerId) ?? null) : null,
    [preselectedPlayerId, roster]
  );

  const [recipient, setRecipient] = useState<RosterMember | null>(preselected);
  const [search, setSearch] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? roster.filter(
          (m) =>
            m.alias.toLowerCase().includes(q) ||
            m.username.toLowerCase().includes(q) ||
            (m.player_number ?? '').toLowerCase().includes(q)
        )
      : roster;
    return list.slice(0, 60);
  }, [roster, search]);

  const maxQuantity = Math.max(1, Math.min(999, item.quantity));
  const step = (delta: number) => setQuantity((q) => Math.min(maxQuantity, Math.max(1, q + delta)));

  if (!canManage) {
    return (
      <Overlay onClose={onCancel} labelledBy="pv-grant-title">
        <h2 id="pv-grant-title" className="pv-dialog__title">
          {item.label}
        </h2>
        <p className="pv-dialog__body">Only Owners And Admins Can Send Items From This Vault.</p>
        <div className="pv-dialog__actions">
          <button type="button" className="pv-btn pv-btn--primary" onClick={onCancel}>
            Close
          </button>
        </div>
      </Overlay>
    );
  }

  return (
    <Overlay onClose={onCancel} labelledBy="pv-grant-title">
      <h2 id="pv-grant-title" className="pv-dialog__title">
        Send {item.label}
      </h2>
      <p className="pv-dialog__sub">
        {count(item.quantity)} In The Vault
        {itemMeta(item) ? ` · ${itemMeta(item)}` : ''}
      </p>

      {!recipient ? (
        <>
          <input
            type="text"
            className="pv-search"
            placeholder={toTitleCase('search by name, username or player number')}
            aria-label="Search Players"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="pv-picker">
            {matches.length === 0 ? (
              <p className="pv-picker__empty">No Players Match That Search.</p>
            ) : (
              matches.map((m) => (
                <button
                  key={m.user_id}
                  type="button"
                  className="pv-picker__row"
                  onClick={() => setRecipient(m)}
                >
                  <RoleBadge role={m.role} size="sm" />
                  <span className="pv-picker__names">
                    <span className="pv-picker__alias">{m.alias}</span>
                    {m.username && m.username.toLowerCase() !== m.alias.toLowerCase() && (
                      <span className="pv-picker__username">{m.username}</span>
                    )}
                  </span>
                  {m.player_number && (
                    <span className="pv-picker__number">No. {m.player_number}</span>
                  )}
                </button>
              ))
            )}
          </div>
          <div className="pv-dialog__actions">
            <button type="button" className="pv-btn pv-btn--ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="pv-chosen">
            <RoleBadge role={recipient.role} size="sm" />
            <span className="pv-chosen__alias">{recipient.alias}</span>
            {recipient.player_number && (
              <span className="pv-chosen__number">No. {recipient.player_number}</span>
            )}
            <button type="button" className="pv-chosen__change" onClick={() => setRecipient(null)}>
              Change
            </button>
          </div>

          <div className="pv-stepper">
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label="Fewer"
              disabled={quantity <= 1}
            >
              −
            </button>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={maxQuantity}
              value={quantity}
              aria-label="Quantity To Send"
              onChange={(e) => {
                const next = Number(e.target.value);
                setQuantity(
                  Number.isFinite(next) ? Math.min(maxQuantity, Math.max(1, Math.floor(next))) : 1
                );
              }}
            />
            <button
              type="button"
              onClick={() => step(1)}
              aria-label="More"
              disabled={quantity >= maxQuantity}
            >
              +
            </button>
          </div>

          <div className="pv-dialog__actions">
            <button type="button" className="pv-btn pv-btn--ghost" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="pv-btn pv-btn--primary"
              disabled={busy || item.quantity < 1}
              onClick={async () => {
                setBusy(true);
                await onConfirm(item, recipient, quantity);
                setBusy(false);
              }}
            >
              {busy ? 'Sending...' : 'Confirm'}
            </button>
          </div>
        </>
      )}
    </Overlay>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   RECORDS
   ═══════════════════════════════════════════════════════════════════════════════ */

function RecordsList({ records, loading }: { records: VaultRecord[]; loading: boolean }) {
  if (loading && records.length === 0) return <PageSkeleton variant="list" />;

  if (records.length === 0) {
    return (
      <div className="pv-empty">
        <span className="pv-empty__mark" aria-hidden="true">
          ◇
        </span>
        <p className="pv-empty__heading">No Records Yet</p>
        <p className="pv-empty__body">Purchases And Items You Send Out Will Be Listed Here.</p>
      </div>
    );
  }

  return (
    <div className="pv-records">
      {records.map((r) => (
        <div key={r.id} className={`pv-record pv-record--${r.action}`}>
          <div className="pv-record__head">
            <span className="pv-record__action">{ACTION_LABEL[r.action]}</span>
            <span className="pv-record__date">{formatWhen(r.created_at)}</span>
          </div>
          <div className="pv-record__main">
            <span className="pv-record__item">{r.item_label}</span>
            {/* &times; not a literal "x": check-title-case reads a bare JsxText
                "x" as a word and upper-cases it to "X3". An HTML entity is
                exempt by that script's own rule, and renders better anyway. */}
            <span className="pv-record__qty">&times;{count(r.quantity)}</span>
          </div>
          <div className="pv-record__foot">
            {r.recipient_name ? (
              <span className="pv-record__to">
                To {r.recipient_name}
                {r.recipient_player_number ? ` · No. ${r.recipient_player_number}` : ''}
              </span>
            ) : (
              <span className="pv-record__to">Into The Vault</span>
            )}
            {r.diamonds_spent > 0 && (
              <span className="pv-record__cost">
                <span aria-hidden="true">◆</span> {count(r.diamonds_spent)}
              </span>
            )}
          </div>
          {r.note && <p className="pv-record__note">{r.note}</p>}
        </div>
      ))}
    </div>
  );
}

function formatWhen(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   HELP
   ═══════════════════════════════════════════════════════════════════════════════ */

function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Overlay onClose={onClose} labelledBy="pv-help-title">
      <h2 id="pv-help-title" className="pv-dialog__title">
        How The Promo Vault Works
      </h2>

      <h3 className="pv-help__heading">Buy Now, Send Later</h3>
      <p className="pv-help__body">
        Items You Buy From The Marketplace With Club Diamonds Are Stored Here Until You Need Them.
        It Is Up To You When To Send Them To Your Downline Or To Yourself.
      </p>

      <h3 className="pv-help__heading">Event Packs Are The Exception</h3>
      <p className="pv-help__body">
        Event Packs Cannot Be Stored. They Must Be Sent Out As Soon As They Are Bought.
      </p>

      <h3 className="pv-help__heading">Sending An Item</h3>
      <p className="pv-help__body">
        Tap An Item You Hold To Open The List Of Players You Can Send It To, Choose How Many, Then
        Confirm. Only Owners And Admins Can Buy Or Send.
      </p>

      <h3 className="pv-help__heading">Records</h3>
      <p className="pv-help__body">
        The Records Tab Keeps Your Purchase History Along With Every Item Received And Sent Out.
      </p>

      <div className="pv-dialog__actions">
        <button type="button" className="pv-btn pv-btn--primary" onClick={onClose}>
          Got It
        </button>
      </div>
    </Overlay>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   OVERLAY
   ═══════════════════════════════════════════════════════════════════════════════ */

function Overlay({
  children,
  onClose,
  labelledBy,
}: {
  children: React.ReactNode;
  onClose: () => void;
  labelledBy: string;
}) {
  // Escape closes, because on a phone the backdrop is often entirely covered by
  // the sheet and there is nothing left to tap outside it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="pv-overlay" onClick={onClose} role="presentation">
      <div
        className="pv-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
