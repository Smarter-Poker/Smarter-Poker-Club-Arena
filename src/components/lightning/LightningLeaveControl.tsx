import { useEffect, useRef, useState } from 'react';
import { useFitText } from '../lobby/game-cards/useFitText';
import { stopLightningPlaying } from '../../lightning/lightningSessionApi';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';
import './LightningLeaveControl.css';

/** Stop matchmaking before the original anchor-seat leave can await cash-out. */
export function LightningLeaveControl({
  clusterId,
  onLeave,
  ensureStopped,
}: {
  clusterId: string;
  onLeave: () => Promise<void>;
  ensureStopped?: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [stopped, setStopped] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const toast = useToast();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const label = busy ? 'Standing Up...' : 'Stand Up & Leave';
  const labelRef = useFitText<HTMLSpanElement>(label, 1, 0.5);
  const leave = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (!stopped) {
        const confirmed = ensureStopped
          ? await ensureStopped()
          : (await stopLightningPlaying(clusterId))?.ok === true;
        if (!mounted.current) return;
        if (!confirmed) {
          toast.warning('Could Not Confirm Your Stop Request. Please Try Again.');
          return;
        }
        setStopped(true);
      }
      // The durable stop already refuses every new deal. The old hand and
      // its committed chips still finish through the original leave owner.
      if (mounted.current) await onLeave();
    } catch (error) {
      reportError(error, 'LightningLeaveControl.leave');
      if (mounted.current) toast.warning('Could Not Confirm Your Leave. Please Try Again.');
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className="lightning-leave-control"
      disabled={busy}
      aria-busy={busy}
      onClick={() => void leave()}
    >
      <span ref={labelRef}>{label}</span>
    </button>
  );
}
