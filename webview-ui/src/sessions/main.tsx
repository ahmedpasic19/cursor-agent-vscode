import { createRoot } from 'react-dom/client';
import { HostMessageSchema } from '../../../src/shared/protocol';
import { send } from '../vscode';
import { SessionsApp } from './SessionsApp';
import { useSessions } from './store';
import './sessions.css';

window.addEventListener('message', (e: MessageEvent) => {
  const parsed = HostMessageSchema.safeParse(e.data);
  if (!parsed.success) {
    console.warn('[cursor-agent] invalid host message', e.data, parsed.error.issues);
    return;
  }
  useSessions.getState().handle(parsed.data);
});

createRoot(document.getElementById('root')!).render(<SessionsApp />);
send({ type: 'ready' });
