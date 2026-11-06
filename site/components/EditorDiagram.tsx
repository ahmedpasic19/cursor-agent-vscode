/**
 * The window, drawn to scale. Three regions, and only the one the extension
 * owns is outlined in bone — the diagram says where it lives before the
 * caption does.
 */
export function EditorDiagram() {
  const rows = (
    count: number,
    x: number,
    y: number,
    widths: number[],
    gap = 14,
  ) =>
    Array.from({ length: count }, (_, i) => (
      <rect
        key={`${x}-${y}-${i}`}
        x={x}
        y={y + i * gap}
        width={widths[i % widths.length]}
        height={4}
        rx={2}
        fill="var(--facet-dim)"
        opacity={0.5}
      />
    ));

  return (
    <div className="diagram">
      <svg viewBox="0 0 1000 468" role="img" aria-labelledby="diagram-title">
        <title id="diagram-title">
          A VS Code window. The activity bar on the far left holds the Cursor
          container with the Sessions and MCP &amp; Plugins views. The editor is
          in the middle. The chat panel is the full-height rail on the right.
        </title>

        {/* window */}
        <rect
          x={0.5}
          y={0.5}
          width={999}
          height={467}
          rx={7}
          fill="var(--ink-deep)"
          stroke="var(--rule)"
        />

        {/* title bar */}
        <line x1={0} y1={30} x2={1000} y2={30} stroke="var(--rule)" />
        {[14, 30, 46].map((cx) => (
          <circle key={cx} cx={cx} cy={15} r={3.5} fill="var(--facet-dim)" opacity={0.55} />
        ))}
        <rect x={430} y={11} width={140} height={8} rx={4} fill="var(--facet-dim)" opacity={0.3} />

        {/* ── activity bar ── */}
        <line x1={46} y1={30} x2={46} y2={468} stroke="var(--rule)" />
        {/* the cube, selected */}
        <rect x={6} y={44} width={34} height={34} rx={5} fill="var(--bone)" opacity={0.1} />
        <rect x={1} y={44} width={2} height={34} fill="var(--bone)" />
        <g transform="translate(14 52) scale(0.75)" fill="var(--bone)">
          <path d="M12 2 20.66 7 12 12 3.34 7z" />
          <path d="M3.34 7 12 12v10l-8.66-5z" fillOpacity=".62" />
          <path d="M12 12l8.66-5v10L12 22z" fillOpacity=".34" />
        </g>
        {[92, 132, 172].map((y) => (
          <rect key={y} x={14} y={y} width={18} height={18} rx={3} fill="var(--facet-dim)" opacity={0.4} />
        ))}

        {/* ── primary sidebar: Sessions + MCP ── */}
        <line x1={256} y1={30} x2={256} y2={468} stroke="var(--rule)" />
        <text
          x={60}
          y={54}
          fill="var(--facet-mid)"
          fontSize={13}
          letterSpacing={1.6}
          fontFamily="var(--font-mono), monospace"
        >
          SESSIONS
        </text>
        {/* session rows, one active */}
        <rect x={56} y={66} width={192} height={26} rx={3} fill="var(--bone)" opacity={0.07} />
        <circle cx={66} cy={79} r={3} fill="var(--live)" />
        <rect x={76} y={72} width={108} height={4} rx={2} fill="var(--facet-mid)" opacity={0.8} />
        <rect x={76} y={82} width={62} height={3} rx={1.5} fill="var(--facet-dim)" />
        {[100, 132, 164, 196].map((y, i) => (
          <g key={y}>
            <circle cx={66} cy={y + 13} r={3} fill="var(--facet-dim)" />
            <rect
              x={76}
              y={y + 6}
              width={[124, 92, 136, 104][i]}
              height={4}
              rx={2}
              fill="var(--facet-dim)"
              opacity={0.65}
            />
            <rect x={76} y={y + 16} width={48} height={3} rx={1.5} fill="var(--facet-dim)" opacity={0.5} />
          </g>
        ))}
        <line x1={46} y1={242} x2={256} y2={242} stroke="var(--rule)" />
        <text
          x={60}
          y={266}
          fill="var(--facet-mid)"
          fontSize={13}
          letterSpacing={1.6}
          fontFamily="var(--font-mono), monospace"
        >
          MCP &amp; PLUGINS
        </text>
        {rows(6, 68, 284, [116, 88, 132, 74], 18)}

        {/* ── editor ── */}
        {/* tabs */}
        <line x1={256} y1={62} x2={700} y2={62} stroke="var(--rule)" />
        <rect x={266} y={38} width={96} height={18} rx={3} fill="var(--bone)" opacity={0.08} />
        <rect x={274} y={45} width={64} height={4} rx={2} fill="var(--facet-mid)" />
        <rect x={382} y={45} width={52} height={4} rx={2} fill="var(--facet-dim)" opacity={0.6} />
        {/* gutter + code */}
        {Array.from({ length: 16 }, (_, i) => (
          <rect key={i} x={268} y={82 + i * 20} width={8} height={3} rx={1.5} fill="var(--facet-dim)" opacity={0.35} />
        ))}
        {rows(16, 290, 81, [210, 148, 262, 96, 188, 132, 236], 20)}
        {/* selection, the thing Ctrl+I sends */}
        <rect x={290} y={197} width={262} height={44} rx={2} fill="var(--bone)" opacity={0.1} />
        <rect x={290} y={241} width={176} height={16} rx={3} fill="var(--ink-lit)" stroke="var(--rule)" />
        <text
          x={298}
          y={253}
          fill="var(--facet-mid)"
          fontSize={10}
          fontFamily="var(--font-mono), monospace"
        >
          Add to Cursor (Ctrl+I)
        </text>

        {/* ── secondary sidebar: the chat. Bone outline: this is the extension. ── */}
        <rect
          x={700.5}
          y={30.5}
          width={299}
          height={437}
          fill="var(--ink-lit)"
          stroke="var(--bone)"
          strokeWidth={1.5}
        />
        {/* its tab strip, sitting next to Claude Code */}
        <line x1={700} y1={64} x2={1000} y2={64} stroke="var(--rule)" />
        <g transform="translate(714 40) scale(0.62)" fill="var(--bone)">
          <path d="M12 2 20.66 7 12 12 3.34 7z" />
          <path d="M3.34 7 12 12v10l-8.66-5z" fillOpacity=".62" />
          <path d="M12 12l8.66-5v10L12 22z" fillOpacity=".34" />
        </g>
        <text
          x={730}
          y={53}
          fill="var(--bone)"
          fontSize={12}
          letterSpacing={1.4}
          fontFamily="var(--font-mono), monospace"
        >
          CURSOR
        </text>
        <rect x={700} y={62} width={92} height={2} fill="var(--bone)" />
        <text
          x={808}
          y={53}
          fill="var(--facet-dim)"
          fontSize={12}
          letterSpacing={1.4}
          fontFamily="var(--font-mono), monospace"
        >
          CLAUDE CODE
        </text>

        {/* dot timeline */}
        {[
          [84, 180],
          [84, 120],
          [108, 148],
          [132, 96],
          [156, 206],
          [180, 132],
          [204, 164],
        ]
          .slice(1)
          .map(([y, w], i) => (
            <g key={y}>
              <circle cx={722} cy={y + 2} r={2.5} fill={i === 2 ? "var(--live)" : "var(--facet-dim)"} />
              <rect x={734} y={y} width={w} height={4} rx={2} fill="var(--facet-mid)" opacity={0.55} />
            </g>
          ))}
        {/* the user's turn, bone */}
        <circle cx={722} cy={86} r={2.5} fill="var(--bone)" />
        <rect x={734} y={78} width={238} height={4} rx={2} fill="var(--bone)" opacity={0.75} />
        <rect x={734} y={88} width={162} height={4} rx={2} fill="var(--bone)" opacity={0.5} />
        {/* a diff summary: the only colour in the drawing */}
        <rect x={734} y={228} width={22} height={4} rx={2} fill="var(--diff-add)" opacity={0.85} />
        <rect x={764} y={228} width={16} height={4} rx={2} fill="var(--diff-del)" opacity={0.85} />

        {/* composer */}
        <rect
          x={712}
          y={386}
          width={276}
          height={68}
          rx={4}
          fill="var(--ink-deep)"
          stroke="var(--rule)"
        />
        <rect x={722} y={396} width={78} height={12} rx={2} fill="var(--facet-dim)" opacity={0.3} />
        <rect x={806} y={396} width={58} height={12} rx={2} fill="var(--facet-dim)" opacity={0.3} />
        <rect x={722} y={418} width={126} height={4} rx={2} fill="var(--facet-dim)" opacity={0.6} />
        <rect x={722} y={438} width={96} height={3} rx={1.5} fill="var(--facet-dim)" opacity={0.4} />
        <rect x={944} y={434} width={34} height={10} rx={2} fill="var(--bone)" opacity={0.18} />
      </svg>

      <div className="diagram-legend">
        <div>
          <span className="legend-key" />
          <h3>Activity bar</h3>
          <p>
            The Cursor container: Account &amp; Usage, the session manager with
            groups and search, and MCP &amp; Plugins.
          </p>
        </div>
        <div>
          <span className="legend-key" data-tone="mid" />
          <h3>Editor</h3>
          <p>
            Where context comes from. Select code and press Ctrl+I, or use the
            CodeLens above the selection.
          </p>
        </div>
        <div>
          <span className="legend-key" data-tone="bone" />
          <h3>Secondary sidebar</h3>
          <p>
            The chat, one session at a time, as a tab beside Claude Code. On VS
            Code before 1.106 it falls back to the left container.
          </p>
        </div>
      </div>
    </div>
  );
}
