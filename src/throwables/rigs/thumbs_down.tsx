/** Bespoke Thumbs Down payload. All CSS times are relative to landing at 300 ms. */
import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './thumbs_down.css';
export const spec: ThrowableSpec = {
  id: 'thumbs_down',
  name: 'Thumbs Down',
  tier: 'free',
  category: 'emoticons',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: {
    ms: 300,
    mode: 'straight',
    upright: true,
  },
  arrival: 'blink-pop',
  payload: {
    sizeU: 1.2,
    anchor: 'face',
    coversAvatar: true,
    ms: 3200,
  },
  beats: [
    {
      at: 300,
      marker: 'fist',
    },
    {
      at: 600,
      marker: 'thumb-down',
    },
    {
      at: 900,
      marker: 'grey-wash',
    },
    {
      at: 1400,
      marker: 'slow-shake',
    },
    {
      at: 3500,
      marker: 'cut',
    },
  ],
  audio: [
    {
      at: 600,
      sample: 'thump_soft',
    },
    {
      at: 1400,
      sample: 'raspberry_short',
    },
  ],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Hand({ open = false }: { open?: boolean }) {
  return (
    <AtlasSprite
      src="thumbs_down"
      rect={open ? [675, 55, 555, 540] : [65, 60, 550, 420]}
      x={-72}
      y={-72}
      width={144}
      height={144}
    />
  );
}
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Hand />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-thumbs_down__shake">
        <g className="thr-thumbs_down__closed">
          <Hand />
        </g>
        <g className="thr-thumbs_down__open">
          <Hand open />
        </g>
        <g className="thr-thumbs_down__grey">
          <Hand open />
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
