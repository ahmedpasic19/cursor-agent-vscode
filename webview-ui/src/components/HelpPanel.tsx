import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { Popover } from './Popover';

const SHORTCUTS: [string, string][] = [
  ['Enter / Shift+Enter', 'Send / new line'],
  ['Shift+Tab', 'Switch Agent · Ask · Plan'],
  ['Esc', 'Stop the run'],
  ['↑ in an empty box', 'Recall your last message'],
  ['@', 'Attach files and folders'],
  ['/', 'Commands, skills and custom prompts (/model, /frontend-design, …)'],
  ['Alt+N', 'New session'],
  ['Ctrl+I', 'Add selection (or focus chat with nothing selected)'],
  ['Ctrl+V · drop', 'Attach a screenshot or image'],
];

/** /help: modes and keyboard shortcuts, shown above the composer. */
export function HelpPanel() {
  const req = useStore((s) => s.helpRequest);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (req > 0) setOpen(true);
  }, [req]);
  return (
    <div className="help-anchor">
      <Popover open={open} onClose={close} placement="above" align="stretch" className="help-popover" label="Help" header={<span>Help · Esc to close</span>}>
        <div className="help-body">
          <p>
            <b>Agent</b> edits files and runs commands. You can review and revert every change. <b>Ask</b> is read-only.{' '}
            <b>Plan</b> proposes a plan you can then run.
          </p>
          <table className="shortcuts">
            <tbody>
              {SHORTCUTS.map(([k, v]) => (
                <tr key={k}>
                  <td>
                    <kbd>{k}</kbd>
                  </td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Popover>
    </div>
  );
}
