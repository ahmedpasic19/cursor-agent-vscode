import { useEffect, useRef, type ReactNode } from 'react';
import { send } from '../vscode';
import { AccountBody } from './AccountSection';
import { ChevronIcon, CloseIcon } from './icons';
import { SessionManagerBody } from './SessionManager';
import { SettingsBody } from './SettingsSection';
import { useSessions } from './store';

function Section({
  title,
  open,
  onToggle,
  action,
  grow,
  children,
}: {
  title: string;
  open: boolean;
  onToggle(): void;
  action?: ReactNode;
  grow?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`section${grow && open ? ' grow' : ''}`}>
      <div className="section-header">
        <button className="section-toggle" aria-expanded={open} onClick={onToggle}>
          <ChevronIcon open={open} />
          <span>{title}</span>
        </button>
        {action}
      </div>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

function Notice() {
  const notice = useSessions((s) => s.notice);
  const dismiss = useSessions((s) => s.dismissNotice);
  useEffect(() => {
    if (!notice || notice.level === 'error') return;
    const t = setTimeout(dismiss, 4000);
    return () => clearTimeout(t);
  }, [notice?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!notice) return null;
  return (
    <div className={`notice ${notice.level}`} role="status">
      <span>{notice.text}</span>
      <button className="row-action visible" aria-label="Dismiss" onClick={dismiss}>
        <CloseIcon />
      </button>
    </div>
  );
}

/** Left sidebar: Account & Usage over the Session Manager, like Claude Code's layout. */
export function SessionsApp() {
  const { account, usage, plan, connection, accountOpen, sessionsOpen, settingsOpen, settingsRequest } = useSessions();
  const setPref = useSessions((s) => s.set);
  const settingsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (settingsRequest) settingsRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [settingsRequest]);
  return (
    <div className="sessions-app">
      <Section
        title="Account & Usage"
        open={accountOpen}
        onToggle={() => setPref('accountOpen', !accountOpen)}
        action={
          <button className="link small" onClick={() => send({ type: 'account/details' })}>
            View details
          </button>
        }
      >
        <AccountBody account={account} usage={usage} plan={plan} />
      </Section>
      <div ref={settingsRef}>
        <Section title="Settings" open={settingsOpen} onToggle={() => setPref('settingsOpen', !settingsOpen)}>
          <SettingsBody connection={connection} account={account} />
        </Section>
      </div>
      <Section title="Session Manager" open={sessionsOpen} onToggle={() => setPref('sessionsOpen', !sessionsOpen)} grow>
        <SessionManagerBody />
      </Section>
      <Notice />
    </div>
  );
}
