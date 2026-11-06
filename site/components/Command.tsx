"use client";

import { useEffect, useState } from "react";

export function Command({
  children,
  sigil = "$",
}: {
  children: string;
  sigil?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="cmd">
      <div className="cmd-text">
        <span className="cmd-sigil" aria-hidden="true">
          {sigil}
        </span>
        <code>{children}</code>
      </div>
      <button
        type="button"
        className="cmd-copy mono"
        onClick={copy}
        data-done={copied}
        aria-label={copied ? "Copied" : `Copy: ${children}`}
      >
        {copied ? "✓" : "copy"}
      </button>
    </div>
  );
}
