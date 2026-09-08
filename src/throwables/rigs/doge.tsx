import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './doge.css';
export const spec: ThrowableSpec = {
  id: 'doge',
  name: 'Doge',
  tier: 'vip',
  category: 'characters',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 200, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 2.2, anchor: 'face', coversAvatar: true, ms: 4133 },
  beats: [
    { at: 200, marker: 'head-pop' },
    { at: 320, marker: 'overshoot' },
    { at: 500, marker: 'settle' },
    { at: 1433, marker: 'glasses-slide' },
    { at: 1600, marker: 'glasses-on' },
    { at: 1633, marker: 'sunburst' },
    { at: 3333, marker: 'wink' },
    { at: 4333, marker: 'cut' },
  ],
  audio: [
    { at: 320, sample: 'boom' },
    { at: 1600, sample: 'tick_settle' },
    { at: 1633, sample: 'chime_shimmer' },
  ],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <AtlasSprite src="doge" rect={[25, 805, 685, 320]} x={-62} y={-34} width={124} height={58} />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-doge__sun">
        <AtlasSprite
          src="doge"
          rect={[720, 700, 520, 510]}
          x={-110}
          y={-110}
          width={220}
          height={220}
        />
      </g>
      <g className="thr-doge__pop">
        <g className="thr-doge__neutral">
          <AtlasSprite
            src="doge"
            rect={[20, 10, 605, 690]}
            x={-57}
            y={-65}
            width={114}
            height={130}
          />
        </g>
        <g className="thr-doge__wink">
          <AtlasSprite
            src="doge"
            rect={[650, 10, 595, 690]}
            x={-57}
            y={-65}
            width={114}
            height={130}
          />
        </g>
        <g className="thr-doge__glasses">
          <AtlasSprite
            src="doge"
            rect={[25, 805, 685, 320]}
            x={-62}
            y={-34}
            width={124}
            height={58}
          />
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
