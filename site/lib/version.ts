import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Read the extension's version from its own package.json at build time, so the
 * .vsix filename on the page can never drift from the repo.
 */
export function extensionVersion(): string {
  try {
    const manifest = readFileSync(
      join(process.cwd(), "..", "package.json"),
      "utf8",
    );
    const parsed = JSON.parse(manifest) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const REPO = "https://github.com/ahmedpasic19/cursor-agent-vscode";
