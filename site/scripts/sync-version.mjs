/**
 * Copies the extension's version into lib/extension-version.json so the page
 * can show it without reading outside its own folder — Vercel builds with
 * `site` as the root directory and never sees the parent manifest.
 *
 * Runs on `npm run build` locally, where the parent IS present, and the result
 * is committed. On Vercel the parent is missing and the committed value stands.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "lib", "extension-version.json");

try {
  const manifest = JSON.parse(
    readFileSync(join(here, "..", "..", "package.json"), "utf8"),
  );
  const next = `${JSON.stringify({ version: manifest.version }, null, 2)}\n`;
  const current = (() => {
    try {
      return readFileSync(target, "utf8");
    } catch {
      return "";
    }
  })();

  if (current !== next) {
    writeFileSync(target, next);
    console.log(`sync-version: ${manifest.version}`);
  }
} catch {
  console.log("sync-version: parent manifest not found, keeping committed value");
}
