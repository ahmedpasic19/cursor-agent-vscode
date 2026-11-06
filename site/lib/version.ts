import manifest from "./extension-version.json";

/**
 * The extension's version, kept in step by scripts/sync-version.mjs on every
 * local build. See that script for why it isn't read from ../package.json.
 */
export const EXTENSION_VERSION: string = manifest.version;

export const REPO = "https://github.com/ahmedpasic19/cursor-agent-vscode";
