import React from 'react';

/** A bounded atlas viewport. foreignObject has the part's actual SVG bounds,
 * unlike a nested SVG image whose invisible sheet expands its parent's bbox
 * and moves CSS fill-box rotation/scale pivots into adjacent atlas cells. */
export function AtlasSprite({
  src,
  rect,
  x,
  y,
  width,
  height,
  fit = 'xMidYMid meet',
  clipPath,
  sheetSize = [1254, 1254],
}: {
  src: string;
  /** Native source size; avoids resampling artwork into a forced square. */
  sheetSize?: readonly [number, number];
  /** Local silhouette isolation when adjacent parts share source rows. */
  clipPath?: string;
  rect: readonly [number, number, number, number];
  x: number;
  y: number;
  width: number;
  height: number;
  /** Stretch only authored liquid drips; solid props preserve their shape. */
  fit?: 'xMidYMid meet' | 'none';
}) {
  const [sx, sy, sw, sh] = rect;
  const scale = Math.min(width / sw, height / sh);
  const dx = fit === 'none' ? width / sw : scale;
  const dy = fit === 'none' ? height / sh : scale;
  const drawnWidth = sw * dx;
  const drawnHeight = sh * dy;
  return (
    <foreignObject x={x} y={y} width={width} height={height} pointerEvents="none">
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        <div
          data-atlas-width={sheetSize[0]}
          data-atlas-height={sheetSize[1]}
          style={{
            flexShrink: 0,
            clipPath,
            width: drawnWidth,
            height: drawnHeight,
            backgroundImage: `url(${import.meta.env.BASE_URL}images/throwables/animated/${src}.webp)`,
            backgroundSize: `${sheetSize[0] * dx}px ${sheetSize[1] * dy}px`,
            backgroundPosition: `${-sx * dx}px ${-sy * dy}px`,
            backgroundRepeat: 'no-repeat',
          }}
        />
      </div>
    </foreignObject>
  );
}
