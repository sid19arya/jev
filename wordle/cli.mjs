#!/usr/bin/env node
// Pretty terminal front end for Jev playing Wordle.
// Usage: node cli.mjs [--profile knockout] [--auto] [--word crane] [--headless] [--no-video] [-y]
//   default: step mode, pauses after each scored guess (Enter/Space or the browser's Next button to continue)
//   --auto:  plays straight through
import readline from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import path from 'node:path';
import { playGame } from './engine.mjs';
import { ROOT, WORDS } from './lib/wordle.mjs';
import { MODEL_ID, hasGatewayKey } from './lib/jev.mjs';
import { PROFILES, DEFAULT_PROFILE, getProfile } from './profiles/index.mjs';
import { C, TILE_BG, BANNER, bgRgb, bold, dim, strike, tile, pad, bar, secs, pct, SPINNER, FEEDBACK, box as termBox } from './lib/term.mjs';

const box = (title, lines, width = BOX_WIDTH) => termBox(title, lines, width);

const args = process.argv.slice(2);
const flag = (...names) => names.some(n => args.includes(n));
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const BOX_WIDTH = 76;

// ---------- game state for rendering ----------
const state = {
  profile: getProfile(), word: undefined, phase: 'starting', rows: [], turn: null, keys: {}, end: null,
  spin: 0, started: Date.now(), auto: false, paused: null, // paused = { turn, resolve } while waiting for the user
};
const newTurn = (turn, remaining) => ({ turn, remaining, attempt: 1, view: null, typed: '', rejected: [], flash: null, done: false, pendingSince: 0 });

// A profile's section rendered as terminal lines.
function sectionLines(section, t) {
  const lines = [C.cyan(section.title)];
  const rows = section.rows || [];
  if (section.columns === 2) {
    const prefixWidth = Math.max(0, ...rows.map(r => (r.prefix || '').length));
    const cell = r => pad(`${dim(pad(r.prefix || '', prefixWidth))} ${r.strong ? bold(C.green(pad(r.label, 5))) : C.white(pad(r.label, 5))} ` +
      `${bar(r.p, 5, r.strong ? C.green : C.cyan)}${pct(r.p)}`, 36);
    for (let i = 0; i < rows.length; i += 2) lines.push(`  ${cell(rows[i])}${rows[i + 1] ? cell(rows[i + 1]) : ''}`);
  } else {
    const prefixWidth = Math.max(0, ...rows.map(r => (r.prefix || '').length));
    for (const r of rows) {
      lines.push(`${r.strong ? C.green('▶') : ' '} ${prefixWidth ? dim(pad(r.prefix || '', prefixWidth)) + ' ' : ''}` +
        `${r.strong ? bold(C.green(pad(r.label, 5))) : C.white(pad(r.label, 5))} ${bar(r.p, 18, r.strong ? C.green : C.grey)} ${bold(pct(r.p))}` +
        `${r.note ? '  ' + C.grey(r.note) : ''}`);
    }
  }
  if (section.more) lines.push(dim(`  … ${section.more} more`));
  if (section.pending) {
    lines.push(`${C.accent(SPINNER[state.spin % SPINNER.length])} ${C.accent(section.pending)} ${dim(secs(Date.now() - t.pendingSince))}`);
  }
  return lines;
}

function render() {
  const s = state, t = s.turn, out = ['', ...BANNER, ''];
  out.push(`  ${dim('profile')} ${C.cyan(s.profile.name)}   ${dim('model')} ${C.white(MODEL_ID)}   ` +
    `${dim('secret')} ${C.white(s.word ? 'set via --word' : 'random')}   ${dim('mode')} ${s.auto ? C.cyan('auto') : C.yellow('step')}`, '');

  // Board + per-row summary
  const boardLines = [];
  for (let r = 0; r < 6; r++) {
    let tiles, note = '';
    if (r < s.rows.length) {
      const row = s.rows[r];
      tiles = [...row.guess].map((l, i) => tile(l, row.states[i])).join(' ');
      note = row.states.every(x => x === 'correct') ? C.green(bold('solved ✓'))
        : `${dim(`${row.before} →`)} ${bold(C.white(String(row.remaining)))} ${dim(row.remaining === 1 ? 'word fits' : 'words fit')}`;
      if (row.walls) note += C.red(`  ${row.walls} rejected`);
    } else if (r === s.rows.length && s.phase === 'playing' && s.paused) {
      tiles = Array.from({ length: 5 }, () => tile('', 'empty')).join(' ');
      note = C.yellow(`⏸ next: guess ${r + 1}`);
    } else if (r === s.rows.length && s.phase === 'playing' && t && !t.done) {
      if (t.flash) {
        tiles = [...t.flash].map(l => tile(l, 'rejected')).join(' ');
        note = C.red(bold('✗ not in word list'));
      } else {
        const sp = C.accent(SPINNER[s.spin % SPINNER.length]);
        tiles = Array.from({ length: 5 }, (_, i) => t.typed[i] ? tile(t.typed[i], 'tbd')
          : i === t.typed.length ? TILE_BG.empty(` ${sp} `) : tile('', 'empty')).join(' ');
        note = C.accent(`← guess ${r + 1}`) + (t.attempt > 1 ? C.yellow(` · try ${t.attempt}`) : '');
      }
    } else {
      tiles = Array.from({ length: 5 }, () => tile('', 'empty')).join(' ');
    }
    boardLines.push(`${tiles}   ${note}`);
  }
  out.push(...box('Board', boardLines).map(l => '  ' + l), '');

  // How Jev is deciding the current guess (sections come from the profile)
  if (s.phase === 'playing' && t) {
    const lines = [`${dim('fits every clue')}  ${bold(C.white(String(t.remaining)))} ${dim(t.remaining === 1 ? 'word' : 'words')}`];
    for (const section of t.view?.sections ?? []) lines.push('', ...sectionLines(section, t));
    if (!t.view) lines.push(`${C.accent(SPINNER[s.spin % SPINNER.length])} ${C.accent('starting…')}`);
    if (t.rejected.length) lines.push('', `${C.red('walls hit')}  ${t.rejected.map(w => C.red(strike(w.toUpperCase()))).join('  ')}`);
    out.push(...box(`Guess ${t.turn} · ${s.profile.title}`, lines).map(l => '  ' + l), '');
  }

  if (s.paused) {
    out.push(`  ${C.yellow(bold(`⏸  Paused after guess ${s.paused.turn}`))}   ${bold('Enter')}${dim('/')}${bold('Space')} ${dim('next turn')}   ` +
      `${bold('A')} ${dim('auto')}   ${bold('Q')} ${dim('quit')}   ${dim('· or use the buttons in the browser')}`, '');
  } else if (s.phase === 'playing' && process.stdin.isTTY) {
    out.push(dim(`  ${s.auto ? 'A: switch to step mode (pause after each guess)' : 'A: switch to auto'}   Q: quit`), '');
  }

  // Feedback history
  if (s.rows.length) {
    const lines = s.rows.map((row, r) => `${dim(String(r + 1))} ${bold(C.white(row.guess.toUpperCase()))}  ` +
      [...row.guess].map((l, i) => { const f = FEEDBACK[row.states[i]]; return f.color(`${f.icon} ${l.toUpperCase()}`); }).join('  ') +
      (row.note ? `  ${dim(row.note)}` : ''));
    lines.push(dim(`${FEEDBACK.correct.color('●')} right spot   ${FEEDBACK.present.color('◐')} wrong spot   ${FEEDBACK.absent.color('○')} not in word`));
    out.push(...box('Feedback', lines).map(l => '  ' + l), '');
  }

  // Keyboard
  const kb = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'].map((row, i) =>
    '  ' + ' '.repeat(i * 2) + [...row].map(k => (TILE_BG[s.keys[k]] ?? bgRgb(70, 70, 72))(C.white(` ${k.toUpperCase()} `))).join(' '));
  out.push(...kb, '');

  if (s.end) {
    const e = s.end;
    const lines = [{
      won: C.green(bold(`🎉 Jev solved ${e.secret.toUpperCase()} in ${e.turns}/6`)),
      lost: C.red(bold(`💀 Out of guesses · answer: ${e.secret.toUpperCase()}`)),
      stuck: C.red(bold(`🧱 Gave up on guess ${e.turns + 1}: no accepted word · answer: ${e.secret.toUpperCase()}`)),
      closed: C.red(bold(`🪟 Game window was closed${e.secret ? ` · answer: ${e.secret.toUpperCase()}` : ''}`)),
    }[e.result]];
    const walls = s.rows.reduce((n, r) => n + r.walls, 0) + (t && !t.done ? t.rejected.length : 0);
    lines.push(`${dim('Jev calls')} ${C.white(String(e.calls))}   ${dim('input tokens')} ${C.white(e.inputTokens.toLocaleString())}   ` +
      `${dim('est. cost')} ${C.white(`$${e.cost.toFixed(4)}`)}` + (e.unmeteredCalls ? C.yellow(` +${e.unmeteredCalls} unmetered`) : ''));
    lines.push(`${dim('rejected words')} ${C.white(String(walls))}   ${dim('total time')} ${C.white(secs(Date.now() - s.started))}`);
    if (e.video) lines.push(`${dim('video')} ${C.cyan(path.relative(ROOT, e.video))}`);
    out.push(...box('Result', lines).map(l => '  ' + l), '');
  }
  if (s.error) out.push(...box('Error', wrap(s.error, BOX_WIDTH - 4).map(C.red)).map(l => '  ' + l), '');

  process.stdout.write('\x1b[H' + out.map(l => l + '\x1b[K').join('\n') + '\x1b[J');
}

function wrap(text, width) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ').flatMap(w => w.match(new RegExp(`.{1,${width}}`, 'g')) ?? [''])) {
      if ((line + ' ' + word).trim().length > width) { lines.push(line); line = word; } else line = (line + ' ' + word).trim();
    }
    lines.push(line);
  }
  return lines;
}

function onEvent(e) {
  const s = state, t = s.turn;
  switch (e.type) {
    case 'turn': s.phase = 'playing'; s.turn = newTurn(e.turn, e.remaining); break;
    case 'attempt': t.attempt = e.attempt; t.typed = ''; t.flash = null; t.view = null; break;
    case 'view': {
      const pending = e.sections.map(x => x.pending).filter(Boolean).join('|');
      if (pending && pending !== t.lastPending) t.pendingSince = Date.now();
      t.lastPending = pending;
      t.view = e;
      break;
    }
    case 'typed': t.typed = e.letters; t.flash = null; break;
    case 'rejected': t.rejected.push(e.guess); t.flash = e.guess; t.typed = ''; break;
    case 'feedback': {
      s.rows.push({ guess: e.guess, states: e.states, before: e.before, remaining: e.remaining, note: e.note, walls: t.rejected.length });
      const rank = { absent: 1, present: 2, correct: 3 };
      [...e.guess].forEach((l, i) => { if ((rank[e.states[i]] ?? 0) > (rank[s.keys[l]] ?? 0)) s.keys[l] = e.states[i]; });
      t.done = true;
      break;
    }
    case 'paused': s.paused = { turn: e.turn, resolve: s.paused?.resolve }; break;
    case 'resumed': if (e.action === 'auto') s.auto = true; s.paused = null; break;
    case 'end': s.phase = 'done'; s.paused = null; s.end = e; break;
  }
  render();
}

// ---------- main ----------
async function main() {
  const interactive = process.stdin.isTTY && !flag('-y', '--yes');
  const headless = flag('--headless');
  let word = opt('--word')?.toLowerCase();
  let profileName = opt('--profile');
  // Step mode needs somewhere to continue from: the terminal (TTY) or the visible browser.
  state.auto = flag('--auto') || (!process.stdin.isTTY && headless);

  process.stdout.write('\x1b[2J\x1b[H');
  console.log(['', ...BANNER, ''].join('\n'));

  if (!hasGatewayKey()) {
    console.log(C.red('  AI_GATEWAY_API_KEY is not set.') + dim(' Add it to .env.\n'));
    process.exit(1);
  }
  try { if (profileName) getProfile(profileName); } catch (err) { console.log(C.red(`  ${err.message}\n`)); process.exit(1); }

  if (interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`  ${dim('model')}  ${C.cyan(MODEL_ID)}`);
    console.log(`  ${dim('mode')}   ${state.auto ? C.cyan('auto') + dim(' (plays straight through)') : C.yellow('step') + dim(' (pauses after each guess; run with --auto to play straight through)')}\n`);
    if (!profileName) {
      PROFILES.forEach((p, i) => console.log(`  ${C.accent(String(i + 1))}  ${bold(pad(p.name, 18))} ${dim(p.description)}`));
      while (true) {
        const ans = (await rl.question(`\n  ${C.accent('?')} Profile ${dim(`(Enter for ${DEFAULT_PROFILE})`)}: `)).trim();
        const pick = !ans ? getProfile() : PROFILES[Number(ans) - 1] ?? PROFILES.find(p => p.name === ans);
        if (pick) { profileName = pick.name; break; }
        console.log(C.red(`    Pick 1–${PROFILES.length} or a profile name.`));
      }
    }
    if (!word) {
      while (true) {
        const ans = (await rl.question(`  ${C.accent('?')} Secret word ${dim('(Enter for random)')}: `)).trim().toLowerCase();
        if (!ans || WORDS.includes(ans)) { word = ans || undefined; break; }
        console.log(C.red(`    "${ans}" isn't in the answer list. Try another.`));
      }
    }
    await rl.question(`  ${C.accent('▶')} Press ${bold('Enter')} to start the game `);
    rl.close();
  }

  if (word && !WORDS.includes(word)) { console.log(C.red(`  "${word}" isn't in the answer list.`)); process.exit(1); }

  Object.assign(state, { word, profile: getProfile(profileName ?? DEFAULT_PROFILE), started: Date.now() });
  process.stdout.write('\x1b[?25l\x1b[2J');
  const restoreCursor = () => process.stdout.write('\x1b[?25h');
  process.on('exit', restoreCursor);
  process.on('SIGINT', () => { restoreCursor(); process.exit(130); });

  // Keys: Enter/Space = next turn, A = toggle auto, Q/Ctrl+C = quit.
  if (process.stdin.isTTY) {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume(); // the start prompts pause stdin when they close
    process.stdin.on('keypress', (str, key = {}) => {
      if ((key.ctrl && key.name === 'c') || key.name === 'q') { restoreCursor(); process.stdin.setRawMode(false); process.exit(130); }
      if (key.name === 'a') {
        state.auto = !state.auto;
        if (state.auto) state.paused?.resolve?.('auto');
        render();
      }
      if (state.paused && ['return', 'enter', 'space', 'n'].includes(key.name)) state.paused.resolve?.('next');
    });
  }
  // Called by the engine when it pauses; the browser's buttons can resolve the same pause.
  const waitForNext = () => new Promise(resolve => { state.paused = { ...(state.paused ?? {}), resolve }; });

  const ticker = setInterval(() => { state.spin++; if (state.phase !== 'done') render(); }, 90);
  render();
  try {
    await playGame({ profile: state.profile.name, word, headless, video: !flag('--no-video'), onEvent,
      shouldPause: () => !state.auto, waitForNext });
  } catch (err) {
    state.phase = 'done';
    state.error = describeError(err);
    process.exitCode = 1;
  } finally {
    clearInterval(ticker);
    render();
    restoreCursor();
    if (process.stdin.isTTY) { process.stdin.setRawMode(false); process.stdin.pause(); }
  }
}

function describeError(err) {
  const msg = err?.data?.error?.message ?? err?.message ?? String(err);
  if (err?.data?.error?.type === 'customer_verification_required') return `Vercel AI Gateway: ${msg}`;
  if (err?.statusCode === 401) return 'Vercel AI Gateway rejected the API key (401). Check AI_GATEWAY_API_KEY in .env.';
  return msg;
}

main();
