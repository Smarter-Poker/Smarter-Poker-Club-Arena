import { useEffect, useRef, useState } from 'react';
import {
  DiamondReplayService,
  bonusReplayTitle,
  type BonusReplay,
  type BonusReplaySummary,
} from '../../services/DiamondReplayService';
import { openInBrowser } from '../../lib/openExternal';
import { reportError } from '../../utils/errorReporter';
import { useToast } from '../common/Toast';
import { SpadeConsole } from '../console/SpadeConsole';
import BonusReplayPlayer from './BonusReplayPlayer';
import styles from './BonusReplay.module.css';

export default function BonusReplayLibrary({ clubId }: { clubId: string }) {
  const [rows, setRows] = useState<BonusReplaySummary[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ id: string; replay: BonusReplay } | null>(null);
  const [share, setShare] = useState<{ id: string; url: string } | null>(null);
  const [posted, setPosted] = useState(false);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const loadCursor = useRef<BonusReplaySummary | undefined>(undefined);
  const toast = useToast();
  const report = (e: unknown) => {
    reportError(e, 'BonusReplayLibrary');
    return e instanceof Error ? e.message : 'The Replay Could Not Be Loaded';
  };
  const load = async (before?: BonusReplaySummary) => {
    if (busyRef.current) return;
    busyRef.current = true;
    loadCursor.current = before;
    setBusy(true);
    setError(null);
    const scope = generation.current;
    try {
      const next = await DiamondReplayService.list(clubId, before);
      if (scope === generation.current) {
        setRows((r) => (before ? [...r, ...next] : next));
        setMore(next.length === 25);
      }
    } catch (e) {
      if (scope === generation.current) setError(report(e));
    } finally {
      if (scope === generation.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    generation.current++;
    busyRef.current = false;
    setRows([]);
    setMore(false);
    setSelected(null);
    setShare(null);
    void load();
    return () => {
      generation.current++;
    };
  }, [clubId]); // The club owns every async result.
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const scope = generation.current;
    try {
      await action();
    } catch (e) {
      if (scope === generation.current) setError(report(e));
    } finally {
      if (scope === generation.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const watch = (id: string) => {
    const scope = generation.current;
    void run(async () => {
      const replay = await DiamondReplayService.read(id);
      if (scope === generation.current) {
        setSelected({ id, replay });
        setShare(null);
        setPosted(false);
      }
    });
  };
  const makeShare = () => {
    if (!selected) return;
    const id = selected.id,
      scope = generation.current;
    void run(async () => {
      const link = await DiamondReplayService.share(id);
      if (scope === generation.current) setShare(link);
    });
  };
  return (
    <SpadeConsole eyebrow="Your Bonus Games" title="Replay Summary" foot="foot">
      {selected ? (
        <>
          <button
            className={styles.action}
            type="button"
            onClick={() => {
              generation.current++;
              busyRef.current = false;
              setBusy(false);
              setSelected(null);
              setShare(null);
              setError(null);
            }}
          >
            Back To Replays
          </button>
          <BonusReplayPlayer key={selected.id} replay={selected.replay} />
          {!share ? (
            <button className={styles.action} type="button" disabled={busy} onClick={makeShare}>
              Share This Replay
            </button>
          ) : (
            <>
              <p className={styles.note}>
                Anyone With This Link Can Watch This Bonus. Your Wallet And Account Details Are
                Private.
              </p>
              <input
                className={styles.link}
                aria-label="Replay Link"
                readOnly
                value={share.url}
                onFocus={(event) => event.currentTarget.select()}
              />
              <div className={styles.sharing}>
                <button
                  className={styles.action}
                  type="button"
                  disabled={busy || posted}
                  onClick={() => {
                    const scope = generation.current;
                    void run(async () => {
                      await DiamondReplayService.post(share.id);
                      if (scope === generation.current) {
                        setPosted(true);
                        toast.success('Replay Shared To Your Smarter.Poker Page');
                      }
                    });
                  }}
                >
                  {posted ? 'Shared To Smarter.Poker' : 'Share To My Smarter.Poker Page'}
                </button>
                <button
                  className={styles.action}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const scope = generation.current;
                    void run(async () => {
                      if (typeof navigator.clipboard?.writeText !== 'function')
                        throw new Error(
                          'Copy Is Unavailable Here. Select The Replay Link To Copy It.'
                        );
                      await navigator.clipboard.writeText(share.url);
                      if (scope === generation.current) toast.success('Replay Link Copied');
                    });
                  }}
                >
                  Copy Link
                </button>
                {typeof navigator.share === 'function' && (
                  <button
                    className={styles.action}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        try {
                          await navigator.share({
                            title: bonusReplayTitle(selected.replay),
                            url: share.url,
                          });
                        } catch (e) {
                          if (!(e instanceof Error && e.name === 'AbortError')) throw e;
                        }
                      })
                    }
                  >
                    Share To An App
                  </button>
                )}
                <button
                  className={styles.action}
                  type="button"
                  onClick={() =>
                    openInBrowser(
                      `https://twitter.com/intent/tweet?text=${encodeURIComponent(bonusReplayTitle(selected.replay))}&url=${encodeURIComponent(share.url)}`
                    )
                  }
                >
                  X
                </button>
                <button
                  className={styles.action}
                  type="button"
                  onClick={() =>
                    openInBrowser(
                      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(share.url)}`
                    )
                  }
                >
                  Facebook
                </button>
                <button
                  className={styles.action}
                  type="button"
                  onClick={() =>
                    openInBrowser(`https://wa.me/?text=${encodeURIComponent(share.url)}`)
                  }
                >
                  WhatsApp
                </button>
                <button
                  className={styles.action}
                  type="button"
                  onClick={() =>
                    openInBrowser(`https://t.me/share/url?url=${encodeURIComponent(share.url)}`)
                  }
                >
                  Telegram
                </button>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          {!busy && rows.length === 0 && !error && (
            <p className="sc-copy">Finish A Bonus Game To Watch And Share Its Replay Here.</p>
          )}
          <div className={styles.rows}>
            {rows.map((r) => (
              <div className={styles.row} key={r.id}>
                <span>
                  {bonusReplayTitle(r)}
                  <small>
                    {new Date(r.created_at).toLocaleString()} · {r.diamonds.toLocaleString()}{' '}
                    Diamonds
                  </small>
                  <strong className="sc-ink--gold">
                    {r.payout_chips.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}{' '}
                    Chips
                  </strong>
                </span>
                <button
                  className={styles.action}
                  type="button"
                  disabled={busy}
                  onClick={() => watch(r.id)}
                >
                  Replay
                </button>
              </div>
            ))}
          </div>
          {more && (
            <button
              className={styles.action}
              type="button"
              disabled={busy}
              onClick={() => void load(rows.at(-1))}
            >
              Older Replays
            </button>
          )}
        </>
      )}
      {busy && (
        <p role="status" className="sc-copy">
          Loading Replay
        </p>
      )}
      {error && (
        <p role="alert" className="sc-copy sc-ink--red">
          {error}
          {!selected && (
            <button
              className={styles.action}
              type="button"
              disabled={busy}
              onClick={() => void load(loadCursor.current)}
            >
              Try Again
            </button>
          )}
        </p>
      )}
    </SpadeConsole>
  );
}
