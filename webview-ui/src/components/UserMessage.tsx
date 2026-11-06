import { useLayoutEffect, useRef, useState } from 'react';
import type { UserMessage as UserItem } from '../../../src/shared/protocol';
import { chipIdsIn, splitChipTokens } from '../../../src/shared/inlineChips';
import { RestoreIcon } from '../sessions/icons';
import { ContextChips, InlineChip } from './ContextChips';

interface Props {
  item: UserItem;
  restorable: boolean;
  running: boolean;
  onRestore(): void;
}

/** Collapsed height of a long message (≈ 6 lines). */
const COLLAPSED_PX = 132;

/** A sent message: chips inline where they were typed, long text folded with Show more/less. */
export function UserMessage({ item, restorable, running, onRestore }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const check = () => setOverflows(el.scrollHeight > COLLAPSED_PX + 8);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [item.text]);

  // Chips not placed in the text (older chats, or attached without a position) go on top.
  const inline = new Set(chipIdsIn(item.text));
  const loose = (item.chips ?? []).filter((c) => !inline.has(c.id));
  const parts = splitChipTokens(item.text, item.chips);
  const collapsed = overflows && !expanded;

  return (
    <div className={`user-msg${collapsed ? ' collapsed' : ''}`}>
      {(loose.length > 0 || item.mode !== 'agent') && (
        <div className="user-head">
          {loose.length > 0 && <ContextChips chips={loose} readOnly />}
          {item.mode !== 'agent' && <span className="user-mode">{item.mode}</span>}
        </div>
      )}
      <div ref={bodyRef} className="user-text" style={collapsed ? { maxHeight: COLLAPSED_PX } : undefined}>
        {parts.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : <InlineChip key={p.id} chip={p} />))}
      </div>
      {overflows && (
        <button className="user-more" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
      {restorable && (
        <button
          className="restore-btn icon-btn"
          disabled={running}
          title="Restore code to before this message (asks first)"
          aria-label="Restore code to before this message"
          onClick={onRestore}
        >
          <RestoreIcon />
        </button>
      )}
    </div>
  );
}
