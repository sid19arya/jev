// Builds the static site served at artifacts.coffeesid.com.
//
// framing-wordle-for-jev.html is authored for the Claude artifact host, which supplies the
// <!doctype>, <head> and <body> itself. For static hosting we add that skeleton here so the one
// source file stays the only copy.
//
// Output:
//   dist/index.html                           a short index of what's published here
//   dist/jev-wordle-exploration/index.html    the page  → /jev-wordle-exploration/
//   dist/jev-wordle-exploration.html          the same  → /jev-wordle-exploration (no trailing slash)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');

const PAGES = [{
  slug: 'jev-wordle-exploration',
  source: 'framing-wordle-for-jev.html',
  description: 'How three ways of framing a Wordle guess as choice questions play out for Jev, a structured decision model.',
  blurb: 'Three ways to ask a decision model to play Wordle: one word from 2,315, five letters in sequence, or five letters at once.',
}];

/** Wraps an artifact-authored page (title, links and styles, then <main>) in a full HTML document. */
function standalone({ source, description }) {
  const page = fs.readFileSync(path.join(HERE, source), 'utf8');
  const split = page.indexOf('<main');
  if (split < 0) throw new Error(`${source}: expected a <main> element`);
  const title = page.match(/<title>(.*?)<\/title>/)?.[1] ?? source;
  return { title, html: `<!doctype html>
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
${page.slice(0, split).trimEnd()}
</head>
<body>
${page.slice(split).trimEnd()}
</body>
</html>
` };
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const built = PAGES.map(page => {
  const { title, html } = standalone(page);
  fs.mkdirSync(path.join(DIST, page.slug), { recursive: true });
  fs.writeFileSync(path.join(DIST, page.slug, 'index.html'), html);   // /slug/
  fs.writeFileSync(path.join(DIST, `${page.slug}.html`), html);       // /slug
  console.log(`built /${page.slug} (${(html.length / 1024).toFixed(1)} KB) — ${title}`);
  return { ...page, title };
});

const index = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artifacts</title>
<meta name="color-scheme" content="light dark">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">
<style>
  :root { --paper: #FAFAF8; --ink: #1C1E23; --muted: #5D626C; --rule: #CDD0D6; --jev: #3346A6; }
  @media (prefers-color-scheme: dark) {
    :root { --paper: #121317; --ink: #E4E5E9; --muted: #9BA0AA; --rule: #34373F; --jev: #93A3F2; }
  }
  body {
    margin: 0; background: var(--paper); color: var(--ink);
    font: 17px/1.6 "Source Serif 4", Georgia, serif;
    padding-inline: 20px; padding-block: 64px;
  }
  main { max-width: 60ch; margin-inline: auto; }
  h1 { font-size: 30px; font-weight: 600; margin: 0 0 6px; }
  .sub { color: var(--muted); margin: 0 0 32px; font-size: 15px; }
  ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 20px; }
  li { border-top: 1px solid var(--rule); padding-top: 16px; }
  a { color: var(--jev); text-decoration: none; font-weight: 600; }
  a:hover { text-decoration: underline; }
  a:focus-visible { outline: 2px solid var(--jev); outline-offset: 3px; }
  .path { font-family: "IBM Plex Mono", monospace; font-size: 12.5px; color: var(--muted); display: block; margin-top: 4px; }
  p.blurb { margin: 6px 0 0; font-size: 15px; color: var(--ink); }
</style>
</head>
<body>
<main>
  <h1>Artifacts</h1>
  <p class="sub">Write-ups and experiments.</p>
  <ul>
${built.map(p => `    <li>
      <a href="/${p.slug}">${p.title}</a>
      <span class="path">/${p.slug}</span>
      <p class="blurb">${p.blurb}</p>
    </li>`).join('\n')}
  </ul>
</main>
</body>
</html>
`;
fs.writeFileSync(path.join(DIST, 'index.html'), index);
console.log('built / (index)');
