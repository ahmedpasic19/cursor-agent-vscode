import { useEffect, useMemo, useRef, useState } from 'react';
import type { Mode } from '../../src/shared/events';
import { CliBanner } from './components/CliBanner';
import { Composer } from './components/Composer';
import { RunMessage } from './components/RunMessage';
import { TabContext } from './components/tools/util';
import { useStore } from './state/store';
import { send } from './vscode';

export function App() {
  const { tabs, activeTabId, defaultMode, focusRequest, cli } = useStore();
  useStore((s) => s.tick); // re-render on streamed events
  const tab = activeTabId ? tabs[activeTabId] : undefined;
  const [mode, setMode] = useState<Mode>(defaultMode);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const modesSupported = cli.features?.modes ?? true;

  useEffect(() => {
    if (tab) setMode(tab.meta.mode);
  }, [tab?.meta.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Run this plan" switches the tab to Agent; mirror that in the composer.
  useEffect(() => {
    if (tab) setMode(tab.meta.mode);
  }, [tab?.meta.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the view pinned to the bottom while streaming, unless the user scrolled up.
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    const el = listRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const running = !!tab?.meta.running;
  const latestRunId = useMemo(() => {
    const t = tab?.transcript ?? [];
    for (let i = t.length - 1; i >= 0; i--) if (t[i]!.role === 'run') return t[i]!.id;
    return undefined;
  }, [tab?.transcript]);
  const ctx = useMemo(() => ({ tabId: tab?.meta.id ?? '', cwd: tab?.meta.cwd, running }), [tab?.meta.id, tab?.meta.cwd, running]);

  return (
    <TabContext.Provider value={ctx}>
      <div className="app">
        <header className="topbar">
          <span className="tab-title" title={tab?.meta.title}>
            {tab?.meta.title ?? 'Cursor Agent'}
          </span>
          <span className="spacer" />
          {running && <span className="running-dot" title="Running" />}
          <button className="icon-btn" title="New chat" aria-label="New chat" onClick={() => send({ type: 'tab/new' })}>
            +
          </button>
        </header>
        <CliBanner cli={cli} />
        <div className="messages" ref={listRef} onScroll={onScroll}>
          {!tab || tab.transcript.length === 0 ? (
            <div className="empty">
              <p>No messages yet.</p>
              <p className="muted">
                Type below and press Enter. <b>Agent</b> edits files and runs commands, <b>Ask</b> is read-only,{' '}
                <b>Plan</b> proposes a plan you can then run. Shift+Tab cycles modes.
              </p>
            </div>
          ) : (
            tab.transcript.map((item) =>
              item.role === 'user' ? (
                <div key={item.id} className="user-msg">
                  <span className={`mode-badge ${item.mode}`}>{item.mode}</span>
                  <div className="user-text">{item.text}</div>
                </div>
              ) : (
                <RunMessage key={item.id} run={item} view={tab.views[item.id]!} isLatest={item.id === latestRunId} />
              ),
            )
          )}
        </div>
        <Composer
          running={running}
          mode={mode}
          modesSupported={modesSupported}
          disabled={!tab || cli.state === 'notFound'}
          focusRequest={focusRequest}
          onModeChange={setMode}
          onSend={(text) => tab && send({ type: 'message/send', tabId: tab.meta.id, text, mode, model: tab.meta.model })}
          onStop={() => tab && send({ type: 'run/stop', tabId: tab.meta.id })}
        />
      </div>
    </TabContext.Provider>
  );
}
