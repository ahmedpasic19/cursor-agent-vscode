import { useEffect } from 'react';
import { useStore } from '../state/store';

/** Transient message above the composer; auto-dismisses after a few seconds. */
export function Notice() {
  const notice = useStore((s) => s.notice);
  const dismiss = useStore((s) => s.dismissNotice);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(dismiss, notice.level === 'error' ? 10000 : 5000);
    return () => clearTimeout(t);
  }, [notice, dismiss]);
  if (!notice) return null;
  return (
    <div className={`notice ${notice.level}`} role="status">
      <span>{notice.text}</span>
      <button className="icon-btn small" aria-label="Dismiss" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}
