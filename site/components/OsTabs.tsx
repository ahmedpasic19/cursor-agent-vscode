"use client";

import { useState } from "react";
import { Command } from "./Command";

type Os = "macOS" | "Linux" | "Windows";

const INSTALL: Record<Os, { sigil: string; commands: string[]; path: string }> =
  {
    macOS: {
      sigil: "$",
      commands: [
        "curl https://cursor.com/install -fsS | bash",
        `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc`,
      ],
      path: "Adds ~/.local/bin to your PATH.",
    },
    Linux: {
      sigil: "$",
      commands: [
        "curl https://cursor.com/install -fsS | bash",
        `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc`,
      ],
      path: "Adds ~/.local/bin to your PATH.",
    },
    Windows: {
      sigil: ">",
      commands: [
        "irm 'https://cursor.com/install?win32=true' | iex",
        `$p = [Environment]::GetEnvironmentVariable("Path", "User"); if ($p -notlike "*$env:LOCALAPPDATA\\cursor-agent*") { [Environment]::SetEnvironmentVariable("Path", "$p;$env:LOCALAPPDATA\\cursor-agent", "User") }`,
      ],
      path: "PowerShell. Adds %LOCALAPPDATA%\\cursor-agent to the user PATH.",
    },
  };

const ORDER: Os[] = ["macOS", "Linux", "Windows"];

export function OsTabs() {
  const [os, setOs] = useState<Os>("macOS");
  const active = INSTALL[os];

  return (
    <div>
      <div className="os-tabs" role="tablist" aria-label="Operating system">
        {ORDER.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            className="os-tab"
            aria-selected={os === name}
            onClick={() => setOs(name)}
          >
            {name}
          </button>
        ))}
      </div>

      {active.commands.map((command) => (
        <Command key={command} sigil={active.sigil}>
          {command}
        </Command>
      ))}

      <p className="step-after">
        {active.path} Open a new terminal, then <code>agent --version</code>{" "}
        should print a version.
      </p>
    </div>
  );
}
