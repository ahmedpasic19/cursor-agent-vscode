// Renders media/logo.svg to media/logo.png (128×128, the extension icon in the Extensions view).
//   node scripts/render-logo.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync(new URL('../media/logo.svg', import.meta.url), 'utf8');
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 128 } }).render().asPng();
writeFileSync(new URL('../media/logo.png', import.meta.url), png);
console.log(`media/logo.png: ${png.length} bytes`);
