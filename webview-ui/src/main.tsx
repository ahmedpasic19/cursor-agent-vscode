import { createRoot } from 'react-dom/client';
import { HostMessageSchema } from '../../src/shared/protocol';
import { App } from './App';
import { useStore } from './state/store';
import { send } from './vscode';
import './theme.css';
import './styles.css';

window.addEventListener('message', (e: MessageEvent) => {
  const parsed = HostMessageSchema.safeParse(e.data);
  if (!parsed.success) {
    console.warn('[cursor-agent] invalid host message', e.data, parsed.error.issues);
    return;
  }
  useStore.getState().handle(parsed.data);
});

createRoot(document.getElementById('root')!).render(<App />);
send({ type: 'ready' });
