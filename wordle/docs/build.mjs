// Wraps the artifact page into a standalone site in dist/.
//
// framing-wordle-for-jev.html is authored for the Claude artifact host, which supplies the
// <!doctype>, <head> and <body> itself. For static hosting we add that skeleton here so the one
// source file stays the only copy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = 'framing-wordle-for-jev.html';
const DIST = path.join(HERE, 'dist');

const page = fs.readFileSync(path.join(HERE, SOURCE), 'utf8');
// The source opens with the title, font links and styles, then the page body starting at <main>.
const split = page.indexOf('<main');
if (split < 0) throw new Error(`${SOURCE}: expected a <main> element`);
const pageHead = page.slice(0, split).trimEnd();
const pageBody = page.slice(split).trimEnd();
const title = page.match(/<title>(.*?)<\/title>/)?.[1] ?? 'Framing Wordle for Jev';
const description = 'How three ways of framing a Wordle guess as choice questions play out for Jev, a structured decision model.';

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="${description}">
<meta name="color-scheme" content="light dark">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:type" content="article">
<style>
  :root { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
  body { margin: 0; }
  img { max-width: 100%; }
  [hidden] { display: none !important; }
</style>
${pageHead}
</head>
<body>
${pageBody}
</body>
</html>
`;

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'index.html'), html);
console.log(`built ${path.relative(process.cwd(), path.join(DIST, 'index.html'))} (${(html.length / 1024).toFixed(1)} KB)`);
