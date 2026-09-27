import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../common/Modal';
import { TapHaptic } from '../haptics/TapHaptic';
import { soundService } from '../../services/SoundService';
import { fireTestVibration, isVibrationPreferred, vibrationPath } from '../../utils/vibrationGate';
import { currentAudioSession } from '../../utils/audioSession';
import {
  deviceLabel,
  probeGraphics,
  qualityTierLabel,
  reportText,
  silentSwitchSummary,
  smoothness,
  vibrationSummary,
} from './deviceReport';
import styles from './DeviceCheck.module.css';

/** How long Measure Smoothness samples the display, in milliseconds. */
export const SMOOTHNESS_SAMPLE_MS = 3000;

type Felt = 'yes' | 'no' | null;

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * THE DEVICE CHECK (2026-09-26). Dan: "there are no buzzing or haptics".
 * Every test so far ran on a computer imitating a phone, so this puts the
 * question to the phone itself: what it is, what it can buzz and play, how it
 * draws, and a button for each that the player (or Dan) presses and answers.
 * Copy Report turns the whole check into text to paste back.
 */
export function DeviceCheck({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [felt, setFelt] = useState<Felt>(null);
  const [buzzAsked, setBuzzAsked] = useState(false);
  const [buzzAnswer, setBuzzAnswer] = useState<boolean | null>(null);
  const [heard, setHeard] = useState<Felt>(null);
  const [soundAsked, setSoundAsked] = useState(false);
  const [soundNote, setSoundNote] = useState<string | null>(null);
  const [smooth, setSmooth] = useState<{ fps: number; slowShare: number } | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const raf = useRef(0);
  const refresh = useRef(0);
  const graphics = useMemo(() => (isOpen ? probeGraphics() : null), [isOpen]);
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      clearTimeout(refresh.current);
    },
    []
  );
  // Closed mid-measure: stop sampling the display at once.
  useEffect(() => {
    if (isOpen) return;
    cancelAnimationFrame(raf.current);
    setMeasuring(false);
  }, [isOpen]);

  const soundOn = soundService.isEnabled();
  const session = currentAudioSession();
  const rows = useMemo<Array<[string, string]>>(() => {
    void tick;
    const screen =
      typeof window === 'undefined'
        ? 'Unknown'
        : `${window.innerWidth} x ${window.innerHeight} At ${window.devicePixelRatio || 1}x`;
    return [
      ['Device', deviceLabel()],
      ['Vibration', vibrationSummary()],
      ['Vibrations Setting', isVibrationPreferred() ? 'On' : 'Off'],
      ['Device Accepted Buzz', buzzAnswer === null ? 'Not Tried' : buzzAnswer ? 'Yes' : 'No'],
      [
        'Test Buzz',
        felt === null
          ? buzzAsked
            ? 'Waiting For Your Answer'
            : 'Not Tried'
          : felt === 'yes'
            ? 'Felt It'
            : 'Felt Nothing',
      ],
      ['Sounds Setting', soundOn ? 'On' : 'Off'],
      ['Sound Engine', soundService.audioState().replace(/^./, (c) => c.toUpperCase())],
      ['Silent Switch', silentSwitchSummary(session, soundOn)],
      [
        'Test Sound',
        heard === null
          ? soundAsked
            ? 'Waiting For Your Answer'
            : 'Not Tried'
          : heard === 'yes'
            ? 'Heard It'
            : 'Heard Nothing',
      ],
      ['Graphics', graphics ? graphics.renderer : 'Not Checked'],
      [
        'Drawn By',
        graphics
          ? graphics.webgl
            ? graphics.software
              ? 'The CPU (Slow)'
              : 'The GPU'
            : 'Nothing: No WebGL'
          : 'Not Checked',
      ],
      ['Game Quality', qualityTierLabel(sessionStore())],
      ['Screen', screen],
      [
        'Smoothness',
        smooth
          ? `${smooth.fps} Frames A Second, ${Math.round(smooth.slowShare * 100)}% Slow`
          : measuring
            ? 'Measuring'
            : 'Not Measured',
      ],
    ];
  }, [
    felt,
    buzzAsked,
    buzzAnswer,
    heard,
    soundAsked,
    soundOn,
    session,
    graphics,
    smooth,
    measuring,
    tick,
  ]);

  const testBuzz = useCallback(() => {
    // Inside the tap: on an iPhone browser the finger on this button's switch is the buzz.
    const fired = fireTestVibration([40, 60, 40]);
    setBuzzAnswer(fired);
    setBuzzAsked(true);
    setFelt(null);
    setTick((t) => t + 1);
  }, []);

  const testSound = useCallback(() => {
    setSoundAsked(true);
    setHeard(null);
    if (!soundService.isEnabled()) {
      setSoundNote('Sounds Are Off In Settings. Turn Them On To Test.');
      return;
    }
    const engine = soundService.audioState();
    if (engine === 'unavailable' || engine === 'closed') {
      setSoundNote('This Browser Has No Working Sound Engine, So Nothing Can Play.');
      return;
    }
    setSoundNote(null);
    soundService.playWin();
    setTick((t) => t + 1);
    // The engine resumes asynchronously inside this tap: read it again shortly.
    clearTimeout(refresh.current);
    refresh.current = window.setTimeout(() => setTick((t) => t + 1), 400);
  }, []);

  const measure = useCallback(() => {
    if (measuring) return;
    setMeasuring(true);
    setSmooth(null);
    const stamps: number[] = [];
    const step = (now: number) => {
      stamps.push(now);
      if (now - stamps[0] < SMOOTHNESS_SAMPLE_MS) raf.current = requestAnimationFrame(step);
      else {
        setSmooth(smoothness(stamps));
        setMeasuring(false);
      }
    };
    raf.current = requestAnimationFrame(step);
  }, [measuring]);

  const copy = useCallback(async () => {
    const text = reportText(rows);
    try {
      await navigator.clipboard.writeText(text);
      setCopied('Report Copied. Paste It Anywhere To Share It.');
      setFallback(null);
    } catch {
      // Copying was refused (no clipboard, or a browser that blocks it): the
      // report goes in a box the player can select and copy by hand.
      setCopied('Copy Was Blocked. The Report Is In The Box Below To Select And Copy.');
      setFallback(text);
    }
  }, [rows]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Device Check"
      size="medium"
      ariaLabel="Device Check"
    >
      <div className={styles.check} data-device-check="">
        <p className={styles.lead}>
          What This Device Can Buzz, Play And Draw. Press Each Test, Answer It, Then Copy The
          Report.
        </p>
        <dl className={styles.rows}>
          {rows.map(([label, value]) => (
            <div key={label} className={styles.row}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className={styles.tests}>
          <button type="button" className={styles.test} onClick={testBuzz}>
            Test Vibration
            <TapHaptic ignorePreference radius="6px" />
          </button>
          <button type="button" className={styles.test} onClick={testSound}>
            Test Sound
            <TapHaptic radius="6px" />
          </button>
          <button type="button" className={styles.test} onClick={measure} disabled={measuring}>
            {measuring ? 'Measuring' : 'Measure Smoothness'}
            <TapHaptic radius="6px" disabled={measuring} />
          </button>
        </div>
        {buzzAsked && (
          <div className={styles.ask} role="group" aria-label="Did You Feel The Buzz?">
            <span>
              {buzzAnswer === false && vibrationPath() !== 'ios-taps'
                ? 'This Device Refused The Buzz. Did You Feel Anything?'
                : 'Did You Feel The Buzz?'}
            </span>
            <button type="button" onClick={() => setFelt('yes')} aria-pressed={felt === 'yes'}>
              Yes
            </button>
            <button type="button" onClick={() => setFelt('no')} aria-pressed={felt === 'no'}>
              No
            </button>
          </div>
        )}
        {soundAsked && !soundNote && (
          <div className={styles.ask} role="group" aria-label="Did You Hear The Sound?">
            <span>Did You Hear The Sound?</span>
            <button type="button" onClick={() => setHeard('yes')} aria-pressed={heard === 'yes'}>
              Yes
            </button>
            <button type="button" onClick={() => setHeard('no')} aria-pressed={heard === 'no'}>
              No
            </button>
          </div>
        )}
        {soundNote && <p className={styles.note}>{soundNote}</p>}
        <button type="button" className={styles.copy} onClick={() => void copy()}>
          Copy Report
        </button>
        {copied && (
          <p className={styles.note} role="status">
            {copied}
          </p>
        )}
        {fallback && (
          <textarea
            className={styles.fallback}
            readOnly
            value={fallback}
            aria-label="Device Check Report"
            rows={8}
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
      </div>
    </Modal>
  );
}

export default DeviceCheck;
