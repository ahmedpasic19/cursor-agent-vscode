import { useMemo } from 'react';

/**
 * "Cubby": the Cursor Agent mascot. A pixel-art isometric cube (three-shade, like the Cursor mark)
 * with big eyes and two little legs. 16×16 pixel grid, rendered as crisp SVG rects.
 *
 *   T = top face (light), L = left face (mid), R = right face (dark),
 *   E = eye, G = eye glint, . = empty
 */
const BODY = [
  '.......TT.......',
  '.....TTTTTT.....',
  '...TTTTTTTTTT...',
  '.TTTTTTTTTTTTTT.',
  'LLTTTTTTTTTTTTRR',
  'LLLLTTTTTTTTRRRR',
  'LLLLLLTTTTRRRRRR',
  'LLLLLLLTTRRRRRRR',
  'LLLGELLLRRRGERRR',
  'LLLEELLLRRREERRR',
  'LLLLLLLLRRRRRRRR',
  'LLLLLLLLRRRRRRRR',
  '.LLLLLLLRRRRRRR.',
  '...LLLLLRRRRR...',
  '.....LLLRRR.....',
  '.......LR.......',
];
const LEGS: [number, number][] = [
  [3, 14],
  [12, 14],
];
const W = 16;
const H = 16;

interface Rect {
  x: number;
  y: number;
  w: number;
  cls: string;
}

/** Merge horizontal runs of the same class into one rect each. */
function runs(grid: string[], map: Record<string, string>): Rect[] {
  const out: Rect[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x]!;
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      if (map[ch]) out.push({ x, y, w: end - x, cls: map[ch]! });
      x = end;
    }
  });
  return out;
}

export function Mascot({ size = 48, state = 'idle', className }: { size?: number; state?: 'idle' | 'working' | 'hop'; className?: string }) {
  const body = useMemo(() => runs(BODY.map((r) => r.replace(/[EG]/g, (_m, i: number) => (i < W / 2 ? 'L' : 'R'))), { T: 'm-top', L: 'm-left', R: 'm-right' }), []);
  const eyes = useMemo(() => runs(BODY.map((r) => r.replace(/[^EG]/g, '.')), { E: 'm-ink', G: 'm-glint' }), []);
  return (
    <svg
      className={`mascot ${state === 'idle' ? '' : state} ${className ?? ''}`}
      width={size}
      height={(size * H) / W}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Cursor Agent mascot"
    >
      <g className="m-body">
        {body.map((r, i) => (
          <rect key={i} x={r.x} y={r.y} width={r.w} height={1} className={r.cls} />
        ))}
        <g className="m-eyes">
          {eyes.map((r, i) => (
            <rect key={i} x={r.x} y={r.y} width={r.w} height={1} className={r.cls} />
          ))}
        </g>
      </g>
      {LEGS.map(([x, y], i) => (
        <rect key={i} x={x} y={y} width={1} height={2} className={`m-leg ${i === 0 ? 'l m-left' : 'r m-right'}`} />
      ))}
    </svg>
  );
}
