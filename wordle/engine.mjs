// Game engine: Playwright drives Wordle in Chromium; a profile (profiles/*.mjs) decides each guess with Jev.
//
// The engine owns the game mechanics: serving the page, reading the colored tiles, typing, the wall
// (Wordle rejecting a word), pausing between turns, and the in-page panel. A profile only implements
// guess(ctx) and describes what it's doing through ctx.show(sections), which the page and the CLI render.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, consistent } from './lib/wordle.mjs';
import { MODEL_ID, createJev } from './lib/jev.mjs';
import { getProfile } from './profiles/index.mjs';

/**
 * A section describes one step of a profile's decision, rendered in the page panel and the CLI:
 *   { title, pending?: 'text while waiting', rows?: [{ prefix?, label, p, strong?, note? }], columns?: 1 | 2, more?: n }
 *
 * @param {object} o
 * @param {string} [o.profile]  profile name (see profiles/index.mjs)
 * @param {string} [o.word]     secret word (random if omitted)
 * @param {boolean} [o.headless]
 * @param {boolean} [o.video]
 * @param {(e: object) => void} [o.onEvent]
 * @param {() => boolean} [o.shouldPause]  checked after each scored guess; true = wait before the next turn
 * @param {() => Promise<'next'|'auto'>} [o.waitForNext]  resolves when the user continues from outside the page (e.g. a keypress)
 * @param {AbortSignal} [o.signal]    stops the game immediately, even mid-call; the result is 'timeout'
 *                                    (closing the game's window also ends it, with result 'closed')
 * @param {string[]} [o.browserArgs]  extra Chromium flags (e.g. window position/scale when tiling windows)
 * @param {string} [o.videoDir]       where to save the recording (default: videos/)
 */
export async function playGame({ profile: profileName, word, headless = false, video = true, onEvent = () => {},
  shouldPause = () => false, waitForNext, signal, browserArgs = [], videoDir = path.join(ROOT, 'videos') } = {}) {
  const profile = getProfile(profileName);
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    const file = path.join(ROOT, pathname === '/' ? 'wordle.html' : pathname);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'text/plain' }).end(fs.readFileSync(file));
  });
  await new Promise(r => server.listen(0, r));
  const url = `http://localhost:${server.address().port}/wordle.html${word ? `?word=${word}` : ''}`;

  const browser = await chromium.launch({ headless, args: browserArgs });
  const context = await browser.newContext({
    viewport: { width: 1100, height: 760 },
    ...(video ? { recordVideo: { dir: videoDir, size: { width: 1100, height: 760 } } } : {}),
  });

  try {
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForSelector('body[data-ready="true"]');
    onEvent({ type: 'browser', url, page, profile: profile.name });

    // In-page panel so the recording shows how Jev is deciding.
    await page.evaluate(label => {
      const p = document.createElement('aside');
      p.id = 'jev-panel';
      p.innerHTML = `<div style="font-weight:700;font-size:15px;margin-bottom:6px">🧠 ${label}</div><div id="jev-body"></div>`;
      Object.assign(p.style, { position: 'fixed', right: '16px', top: '70px', width: '330px', maxHeight: 'calc(100vh - 90px)',
        overflow: 'hidden', background: '#1d1d1f', border: '1px solid #3a3a3c', borderRadius: '8px', padding: '12px',
        fontFamily: 'monospace', fontSize: '12px', color: '#eee' });
      document.body.appendChild(p);
    }, `Jev · ${profile.title}`);

    const renderPanel = (status, sections = []) => page.evaluate(({ status, sections }) => {
      const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      let html = `<div style="color:#aaa;margin-bottom:4px">${esc(status)}</div>`;
      for (const s of sections) {
        html += `<div style="color:#a78bfa;font-weight:700;margin:10px 0 4px">${esc(s.title)}</div>`;
        const prefixWidth = Math.max(0, ...(s.rows || []).map(r => (r.prefix || '').length));
        for (const r of s.rows || []) html += `
          <div style="display:flex;align-items:center;gap:6px;margin:2px 0;${r.strong ? 'color:#6aaa64;font-weight:700' : ''}">
            ${prefixWidth ? `<span style="width:${prefixWidth + 1}ch;white-space:nowrap;color:#888;font-weight:400">${esc(r.prefix || '')}</span>` : ''}
            <span style="width:6ch">${esc(r.label)}</span>
            <span style="flex:1;background:#333;height:8px;border-radius:3px;overflow:hidden">
              <span style="display:block;height:100%;width:${(r.p * 100).toFixed(1)}%;background:${r.strong ? '#6aaa64' : '#8a8a8e'}"></span></span>
            <span style="width:4ch;text-align:right">${Math.round(r.p * 100)}%</span></div>
          ${r.note ? `<div style="color:#777;margin:0 0 3px ${prefixWidth + 1}ch;font-size:11px">${esc(r.note)}</div>` : ''}`;
        if (s.more) html += `<div style="color:#777">… ${s.more} more</div>`;
        if (s.pending) html += `<div style="color:#888">${esc(s.pending)}</div>`;
      }
      document.getElementById('jev-body').innerHTML = html;
    }, { status, sections });

    // Step mode: show Next/Auto buttons in the page and wait for a click there or a resume from the caller.
    const pause = async turn => {
      onEvent({ type: 'paused', turn });
      const clicked = page.evaluate(turn => new Promise(resolve => {
        const bar = document.createElement('div');
        bar.id = 'jev-step';
        bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:12px;padding-top:10px;border-top:1px solid #3a3a3c';
        const button = (label, bg, action) => {
          const b = document.createElement('button');
          b.textContent = label;
          b.style.cssText = `flex:1;padding:8px 0;border:0;border-radius:6px;background:${bg};color:#fff;font:700 13px monospace;cursor:pointer`;
          b.onclick = () => window.__jevResume(action);
          return b;
        };
        const label = document.createElement('div');
        label.textContent = `⏸ after guess ${turn}`;
        label.style.cssText = 'color:#aaa;white-space:nowrap';
        bar.append(label, button('Next turn ▶', '#538d4e', 'next'), button('Auto ⏩', '#565758', 'auto'));
        document.getElementById('jev-panel').appendChild(bar);
        window.__jevResume = action => { bar.remove(); window.__jevResume = null; resolve(action); };
      }), turn).catch(() => 'next');
      const action = await Promise.race([clicked, ...(waitForNext ? [waitForNext()] : [])]);
      await page.evaluate(action => window.__jevResume?.(action), action).catch(() => {});
      onEvent({ type: 'resumed', turn, action });
    };

    const readBoard = () => page.$$eval('#board .row', rows => rows.map(r => [...r.children].map(t => ({
      letter: t.textContent.toLowerCase(), state: t.dataset.state }))).filter(r => r.every(t => ['correct', 'present', 'absent'].includes(t.state))));

    const jev = createJev();
    const maxAttempts = profile.config?.maxAttempts ?? 10;
    const rejections = []; // [{ turn, attempt, word }] for the whole game: a non-word stays a non-word
    let result;

    // Stopping: the caller's signal (time limit) or the game's window being closed ends the game immediately,
    // even mid-call; whatever was in flight is abandoned.
    const stop = new AbortController();
    const stopFromCaller = () => stop.abort('timeout');
    if (signal?.aborted) stopFromCaller(); else signal?.addEventListener('abort', stopFromCaller, { once: true });
    page.on('close', () => stop.abort('closed'));
    const stopped = new Promise((_, reject) => stop.signal.addEventListener('abort', () => reject(stop.signal.reason), { once: true }));
    stopped.catch(() => {});
    const untilStopped = work => { work.catch(() => {}); return Promise.race([work, stopped]); };

    try {
      turns: for (let turn = 1; turn <= 6; turn++) {
        const history = await untilStopped(readBoard());
        const candidates = consistent(history);
        onEvent({ type: 'turn', turn, remaining: candidates.length });

        for (let attempt = 1; ; attempt++) {
          if (attempt > maxAttempts) { result = 'stuck'; break turns; }
          onEvent({ type: 'attempt', turn, attempt });

          let typed = '';
          const type = async ch => {
            await page.keyboard.press(ch, { delay: 50 });
            typed += ch;
            onEvent({ type: 'typed', turn, attempt, letters: typed });
          };
          const ctx = {
            turn, attempt, maxAttempts, history, candidates, config: profile.config,
            rejections: rejections.map(r => ({ ...r })), rejected: rejections.map(r => r.word),
            ask: async (state, questions) => {
              const answers = await jev.ask(state, questions, { signal: stop.signal });
              onEvent({ type: 'usage', turn, attempt, ...jev.totals, cost: jev.cost() });
              return answers;
            },
            type,
            wait: ms => page.waitForTimeout(ms),
            show: async (sections, status = '') => {
              const snapshot = structuredClone(sections);
              onEvent({ type: 'view', turn, attempt, status, sections: snapshot });
              await renderPanel(status, snapshot);
            },
          };

          const choice = await untilStopped(profile.guess(ctx));
          if (!choice?.word) { result = 'stuck'; break turns; }
          const guess = choice.word.toLowerCase();

          const submitted = await untilStopped((async () => {
            // Profiles may type as they go (letter by letter) or return a whole word for the engine to type.
            if (typed !== guess) {
              for (let i = 0; i < typed.length; i++) await page.keyboard.press('Backspace');
              typed = '';
              for (const ch of guess) { await type(ch); await page.waitForTimeout(120); }
            }
            await page.evaluate(() => delete document.body.dataset.submit);
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.body.dataset.submit);
            return page.evaluate(() => document.body.dataset.submit);
          })());

          if (submitted === 'invalid') {
            // The wall: the game rejected the word. Clear the row and let the profile try again.
            rejections.push({ turn, attempt, word: guess });
            onEvent({ type: 'rejected', turn, attempt, guess });
            await untilStopped((async () => {
              await page.waitForTimeout(700);
              for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace', { delay: 40 });
            })());
            continue;
          }

          const after = await untilStopped((async () => {
            await page.waitForFunction(() => document.body.dataset.busy === 'false');
            return readBoard();
          })());
          onEvent({ type: 'feedback', turn, attempt, guess, note: choice.note, states: after[after.length - 1].map(t => t.state),
            before: candidates.length, remaining: consistent(after).length });
          result = await untilStopped(page.evaluate(() => document.body.dataset.result));
          if (result) break turns;
          if (shouldPause()) await untilStopped(pause(turn));
          break;
        }
      }
    } catch (err) {
      if (!stop.signal.aborted) throw err;
      result = stop.signal.reason; // 'timeout' or 'closed'
    }
    signal?.removeEventListener('abort', stopFromCaller);

    const closed = page.isClosed();
    const turns = closed ? undefined : (await readBoard()).length;
    const secret = closed ? word : await page.evaluate(() => window.__wordleSecret);
    if (!closed) {
      await renderPanel({ won: 'Solved! 🎉', lost: 'Out of guesses', stuck: `Gave up: no accepted word after ${maxAttempts} tries`,
        timeout: 'Stopped: time limit' }[result]);
      await page.waitForTimeout(2000);
    }
    const vid = page.video();
    await context.close();
    const videoPath = vid ? await vid.path().catch(() => undefined) : undefined;
    const summary = { result, secret, turns, profile: profile.name, model: MODEL_ID, ...jev.totals, cost: jev.cost(), video: videoPath };
    onEvent({ type: 'end', ...summary });
    return summary;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    server.close();
  }
}
