#!/usr/bin/env node
// Versus: plays several profiles on the same secret word at the same time, side by side, and records it.
//
// Usage: node versus.mjs [--word crane] [--profiles knockout,letter-by-letter,parallel-letters]
//                        [--time-limit 12] [--headless] [--no-video]
//
// Each profile gets its own Chromium window (tiled across the top of the screen on Windows) and the terminal
// shows a live dashboard. Output goes to runs/versus-<stamp>/: events.jsonl, summary.json, summary.md,
// one MP4 per profile and a labelled side-by-side MP4 (needs ffmpeg on PATH).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { playGame } from './engine.mjs';
import { ROOT, WORDS } from './lib/wordle.mjs';
import { MODEL_ID, hasGatewayKey } from './lib/jev.mjs';
import { PROFILES, getProfile } from './profiles/index.mjs';
import { C, BANNER, bold, dim, strike, tile, pad, SPINNER } from './lib/term.mjs';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const profiles = (opt('--profiles')?.split(',') ?? PROFILES.map(p => p.name)).map(name => getProfile(name.trim()));
const word = (opt('--word') ?? WORDS[Math.floor(Math.random() * WORDS.length)]).toLowerCase();
const timeLimitMin = Number(opt('--time-limit') ?? 12);
const headless = flag('--headless');
const video = !flag('--no-video');

if (!hasGatewayKey()) { console.error('AI_GATEWAY_API_KEY is not set (add it to .env).'); process.exit(1); }
if (!WORDS.includes(word)) { console.error(`"${word}" isn't in the answer list.`); process.exit(1); }

const now = new Date(), two = n => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
const runDir = path.join(ROOT, 'runs', `versus-${stamp}`);
fs.mkdirSync(runDir, { recursive: true });
const eventLog = fs.createWriteStream(path.join(runDir, 'events.jsonl'));

// ---------- window tiling ----------
// Chromium's --force-device-scale-factor shrinks the 1100×760 page to fit a third of the screen without changing
// its layout. Window position and size flags are then in scaled units: physical px = value × scale factor.
function tilingArgs(count) {
  if (headless || process.platform !== 'win32') return () => [];
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; $w=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; ' +
      '$v=Get-CimInstance Win32_VideoController | Select-Object -First 1; "$($w.Width) $($v.CurrentHorizontalResolution)"'], { encoding: 'utf8' });
    const [, physicalWidth] = out.trim().split(/\s+/).map(Number);
    const windowPhysical = Math.floor(physicalWidth / count);
    const dsf = Math.min(1, (windowPhysical - 24) / 1100);
    return i => [`--force-device-scale-factor=${dsf.toFixed(3)}`,
      `--window-position=${Math.round(i * windowPhysical / dsf)},0`,
      `--window-size=${Math.round(windowPhysical / dsf)},${760 + 110}`];
  } catch { return () => []; }
}
const windowArgs = tilingArgs(profiles.length);

// ---------- live state ----------
const started = Date.now();
const games = profiles.map(profile => ({
  profile, rows: [], typed: '', flash: null, turn: 1, attempt: 1, remaining: WORDS.length, status: 'starting…',
  calls: 0, cost: 0, rejected: [], result: null, summary: null, error: null, finishedMs: null, videoStartMs: null,
}));

function onEvent(game, e) {
  const t = Date.now() - started;
  if (e.type !== 'view' && e.type !== 'typed' && e.type !== 'browser') {
    const { callMs, ...rest } = e;
    eventLog.write(JSON.stringify({ t, profile: game.profile.name, ...rest }) + '\n');
  }
  switch (e.type) {
    case 'browser': game.videoStartMs = t; break;
    case 'turn': Object.assign(game, { turn: e.turn, remaining: e.remaining, typed: '', flash: null }); break;
    case 'attempt': Object.assign(game, { attempt: e.attempt, typed: '', flash: null }); break;
    case 'typed': Object.assign(game, { typed: e.letters, flash: null }); break;
    case 'view': {
      const pending = e.sections.map(s => s.pending).find(Boolean);
      game.status = pending ?? e.status ?? game.status;
      break;
    }
    case 'usage': Object.assign(game, { calls: e.calls, cost: e.cost }); break;
    case 'rejected': game.rejected.push({ turn: e.turn, attempt: e.attempt, word: e.guess }); Object.assign(game, { flash: e.guess, typed: '' }); break;
    case 'feedback': game.rows.push({ guess: e.guess, states: e.states, remaining: e.remaining, note: e.note, attempt: e.attempt }); game.typed = ''; break;
    case 'end': Object.assign(game, { result: e.result, summary: e, finishedMs: t, calls: e.calls, cost: e.cost }); break;
  }
}

// ---------- dashboard ----------
const clock = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const RESULT = {
  won: g => C.green(bold(`✓ solved in ${g.summary.turns}`)),
  lost: () => C.red(bold('✗ out of guesses')),
  stuck: g => C.red(bold(`🧱 gave up on guess ${g.rows.length + 1}`)),
  timeout: () => C.yellow(bold('⏱ stopped: time limit')),
  error: () => C.red(bold('error')),
};
let spin = 0;

function column(g, width) {
  const lines = [bold(C.cyan(g.profile.title)), dim(g.profile.name)];
  const statusText = g.result ? RESULT[g.result](g) : g.error ? C.red(g.error.slice(0, width)) :
    `${C.accent(SPINNER[spin % SPINNER.length])} ${C.white(`guess ${g.turn}`)}${g.attempt > 1 ? C.yellow(` · try ${g.attempt}`) : ''}`;
  lines.push(statusText, '');
  for (let r = 0; r < 6; r++) {
    let tiles, note = '';
    if (r < g.rows.length) {
      const row = g.rows[r];
      tiles = [...row.guess].map((l, i) => tile(l, row.states[i])).join('');
      note = row.states.every(s => s === 'correct') ? C.green('✓') : dim(`${row.remaining} fit`);
    } else if (r === g.rows.length && !g.result) {
      tiles = g.flash ? [...g.flash].map(l => tile(l, 'rejected')).join('')
        : Array.from({ length: 5 }, (_, i) => tile(g.typed[i] ?? '', g.typed[i] ? 'tbd' : 'empty')).join('');
      note = g.flash ? C.red('✗') : '';
    } else {
      tiles = Array.from({ length: 5 }, () => tile('', 'empty')).join('');
    }
    lines.push(`${tiles} ${note}`);
  }
  lines.push('');
  const status = g.result ? '' : g.status;
  lines.push(dim(status.length > width ? status.slice(0, width - 1) + '…' : status));
  lines.push(`${dim('calls')} ${C.white(String(g.calls).padEnd(5))}${dim('cost')} ${C.white(`$${g.cost.toFixed(4)}`)}`);
  const accepted = g.rows.length;
  lines.push(`${dim('accepted')} ${C.white(String(accepted).padEnd(3))}${dim('rejected')} ${g.rejected.length ? C.red(String(g.rejected.length)) : C.white('0')}`);
  const walls = g.rejected.slice(-4).map(r => C.red(strike(r.word.toUpperCase()))).join(' ');
  lines.push(walls ? `${dim('walls')} ${walls}` : '');
  if (g.finishedMs) lines.push(`${dim('finished at')} ${C.white(clock(g.finishedMs))}`);
  return lines;
}

function render() {
  const cols = process.stdout.columns || 140;
  const width = Math.max(30, Math.floor((cols - 4) / games.length) - 3);
  const out = ['', ...BANNER.slice(0, 6), ''];
  const done = games.every(g => g.result || g.error);
  out.push(`  ${bold('VERSUS')}  ${dim('model')} ${C.white(MODEL_ID)}   ${dim('secret')} ${done ? C.green(bold(word.toUpperCase())) : C.white('hidden')}   ` +
    `${dim('elapsed')} ${C.white(clock(Date.now() - started))} ${dim(`/ ${clock(timeLimitMin * 60_000)} limit`)}`, '');
  const columns = games.map(g => column(g, width));
  const height = Math.max(...columns.map(c => c.length));
  for (let i = 0; i < height; i++) out.push('  ' + columns.map(c => pad(c[i] ?? '', width)).join(C.accent(' │ ')));
  out.push('');
  process.stdout.write('\x1b[H' + out.map(l => l + '\x1b[K').join('\n') + '\x1b[J');
}

// ---------- run ----------
process.stdout.write('\x1b[?25l\x1b[2J');
const restoreCursor = () => process.stdout.write('\x1b[?25h');
process.on('exit', restoreCursor);
process.on('SIGINT', () => { restoreCursor(); process.exit(130); });

const controller = new AbortController();
const limitTimer = setTimeout(() => controller.abort(), timeLimitMin * 60_000);
const ticker = setInterval(() => { spin++; render(); }, 120);
render();

await Promise.all(games.map(async (g, i) => {
  try {
    await playGame({ profile: g.profile.name, word, headless, video, videoDir: runDir, signal: controller.signal,
      browserArgs: windowArgs(i), onEvent: e => onEvent(g, e) });
  } catch (err) {
    g.error = err?.data?.error?.message ?? err?.message ?? String(err);
    g.result = 'error';
    g.finishedMs = Date.now() - started;
    eventLog.write(JSON.stringify({ t: g.finishedMs, profile: g.profile.name, type: 'error', message: g.error }) + '\n');
  }
}));
clearTimeout(limitTimer);
clearInterval(ticker);
render();
restoreCursor();
eventLog.end();

// ---------- summary ----------
const stats = ms => {
  if (!ms?.length) return null;
  const s = [...ms].sort((a, b) => a - b), at = q => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { mean: s.reduce((a, b) => a + b, 0) / s.length, median: at(0.5), p95: at(0.95) };
};
const results = games.map(g => {
  const e = g.summary ?? {};
  const accepted = g.rows.length, tries = accepted + g.rejected.length;
  return {
    profile: g.profile.name, title: g.profile.title, description: g.profile.description,
    result: g.result, error: g.error, guessesUsed: accepted, wordsTyped: tries, rejected: g.rejected.length,
    validWordRate: tries ? accepted / tries : null,
    calls: e.calls ?? g.calls, unmeteredCalls: e.unmeteredCalls ?? 0, inputTokens: e.inputTokens ?? 0, outputTokens: e.outputTokens ?? 0,
    cost: e.cost ?? g.cost, callsPerAcceptedGuess: accepted ? (e.calls ?? g.calls) / accepted : null,
    costPerAcceptedGuess: accepted ? (e.cost ?? g.cost) / accepted : null,
    callLatencyMs: stats(e.callMs), finishedMs: g.finishedMs, videoStartMs: g.videoStartMs,
    guesses: g.rows.map(r => ({ word: r.guess, states: r.states, remainingAfter: r.remaining, tries: r.attempt })),
    rejectedWords: g.rejected, video: e.video,
  };
});

// Videos: name per profile, then an MP4 each and a labelled side-by-side.
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const videos = [];
let sideBySide = null;
if (video) {
  for (const r of results) {
    if (!r.video || !fs.existsSync(r.video)) continue;
    const webm = path.join(runDir, `${r.profile}.webm`);
    fs.renameSync(r.video, webm);
    r.video = webm;
    if (ffmpeg) {
      const mp4 = path.join(runDir, `${r.profile}.mp4`);
      spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', webm, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: 'inherit' });
      r.mp4 = mp4;
      videos.push(r);
    }
  }
  if (ffmpeg && videos.length > 1) {
    const duration = file => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout) || 0;
    const durations = videos.map(r => duration(r.mp4));
    const longest = Math.max(...durations);
    const font = ['C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/arial.ttf'].find(f => fs.existsSync(f));
    const fontArg = font ? `fontfile='${font.replace(':', '\\:')}':` : '';
    const clean = s => s.replace(/[:'\\%,]/g, ' ');
    const resultLabel = r => clean({
      won: `solved in ${r.guessesUsed}`, lost: 'out of guesses', stuck: `gave up on guess ${r.guessesUsed + 1}`, timeout: 'stopped at time limit', error: 'error',
    }[r.result] + ` · ${r.calls} calls · ${r.rejected} rejected · $${r.cost.toFixed(4)}`);
    const filters = videos.map((r, i) => {
      const resultAt = Math.max(0, ((r.finishedMs ?? 0) - (r.videoStartMs ?? 0)) / 1000 - 1.5);
      return `[${i}:v]tpad=stop_mode=clone:stop_duration=${(longest - durations[i] + 0.5).toFixed(2)},crop=800:760:300:0,` +
        `pad=800:860:0:90:color=0x121213,` +
        `drawtext=${fontArg}text='${clean(r.title)}':expansion=none:x=(w-text_w)/2:y=14:fontsize=32:fontcolor=white,` +
        `drawtext=${fontArg}text='${resultLabel(r)}':expansion=none:x=(w-text_w)/2:y=56:fontsize=22:fontcolor=0x6aaa64:enable='gte(t,${resultAt.toFixed(2)})'[v${i}]`;
    });
    const target = path.join(runDir, 'side-by-side.mp4');
    const res = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...videos.flatMap(r => ['-i', r.mp4]), '-filter_complex',
      `${filters.join(';')};${videos.map((_, i) => `[v${i}]`).join('')}hstack=inputs=${videos.length},scale=1920:-2[out]`,
      '-map', '[out]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', target],
    { stdio: 'inherit' });
    if (res.status === 0) sideBySide = path.basename(target);
  }
}

const summary = { stamp, model: MODEL_ID, secret: word, timeLimitMin, elapsedMs: Date.now() - started, results, sideBySide };
fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(runDir, 'summary.md'), summaryMarkdown(summary));

function summaryMarkdown(s) {
  const rs = s.results;
  const money = v => v == null ? '–' : `$${v.toFixed(4)}`;
  const num = v => v == null ? '–' : Number.isInteger(v) ? v.toLocaleString() : v.toFixed(1);
  const pctOf = v => v == null ? '–' : `${(v * 100).toFixed(1)}%`;
  const ms = v => v == null ? '–' : `${(v / 1000).toFixed(2)}s`;
  const resultCell = r => ({ won: `🏆 solved in ${r.guessesUsed}/6`, lost: '❌ out of guesses', stuck: `🧱 gave up on guess ${r.guessesUsed + 1}`,
    timeout: '⏱ stopped at time limit', error: `⚠️ error: ${r.error}` }[r.result] ?? r.result);
  const row = (label, f) => `| ${label} | ${rs.map(f).join(' | ')} |`;
  const emoji = { correct: '🟩', present: '🟨', absent: '⬛' };

  const lines = [
    `# Jev plays Wordle: strategy versus`,
    '',
    `- Secret word: **${s.secret.toUpperCase()}**`,
    `- Model: \`${s.model}\` via Vercel AI Gateway · time limit ${s.timeLimitMin} min · total run ${ms(s.elapsedMs)}`,
    `- All profiles played the same word at the same time${s.sideBySide ? ' · video: `' + s.sideBySide + '`' : ''}`,
    '',
    `| Metric | ${rs.map(r => `${r.title} (\`${r.profile}\`)`).join(' | ')} |`,
    `|---|${rs.map(() => '---').join('|')}|`,
    row('Result', resultCell),
    row('Accepted guesses', r => num(r.guessesUsed)),
    row('Words typed (accepted + rejected)', r => num(r.wordsTyped)),
    row('Rejected by the game', r => num(r.rejected)),
    row('Valid-word rate', r => pctOf(r.validWordRate)),
    row('Jev calls', r => num(r.calls) + (r.unmeteredCalls ? ` (${r.unmeteredCalls} unmetered)` : '')),
    row('Calls per accepted guess', r => num(r.callsPerAcceptedGuess)),
    row('Input tokens', r => num(r.inputTokens)),
    row('Cost (input tokens × list price)', r => money(r.cost)),
    row('Cost per accepted guess', r => money(r.costPerAcceptedGuess)),
    row('Jev call latency (mean / median / p95)', r => r.callLatencyMs ? `${ms(r.callLatencyMs.mean)} / ${ms(r.callLatencyMs.median)} / ${ms(r.callLatencyMs.p95)}` : '–'),
    row('Time until finished', r => ms(r.finishedMs)),
    '',
    '## Guesses',
    '',
  ];
  for (const r of rs) {
    lines.push(`**${r.title}**: ${resultCell(r)}`, '');
    if (r.guesses.length) {
      lines.push('```');
      for (const g of r.guesses) lines.push(`${[...g.word].map((_, i) => emoji[g.states[i]]).join('')}  ${g.word.toUpperCase()}  ${g.remainingAfter} fit after${g.tries > 1 ? ` · accepted on try ${g.tries}` : ''}`);
      lines.push('```');
    } else lines.push('_No guess was accepted._');
    if (r.rejectedWords.length) {
      const shown = r.rejectedWords.slice(0, 30).map(w => w.word.toUpperCase()).join(', ');
      lines.push('', `Rejected (${r.rejectedWords.length}): ${shown}${r.rejectedWords.length > 30 ? ', …' : ''}`);
    }
    lines.push('');
  }

  // Data-driven takeaways; interpretation is left to the reader.
  const winners = rs.filter(r => r.result === 'won').sort((a, b) => a.guessesUsed - b.guessesUsed || a.finishedMs - b.finishedMs);
  const takeaways = [];
  if (winners.length) takeaways.push(`Solved: ${winners.map(r => `${r.title} in ${r.guessesUsed} guesses (${ms(r.finishedMs)})`).join('; ')}.`);
  else takeaways.push('No profile solved the word.');
  const unsolved = rs.filter(r => r.result !== 'won');
  if (unsolved.length) takeaways.push(`Did not solve: ${unsolved.map(r => `${r.title} (${resultCell(r).replace(/^\S+ /, '')})`).join('; ')}.`);
  const withTries = rs.filter(r => r.wordsTyped);
  if (withTries.length) takeaways.push(`Valid-word rate: ${withTries.map(r => `${r.title} ${pctOf(r.validWordRate)} (${r.guessesUsed}/${r.wordsTyped})`).join(', ')}.`);
  takeaways.push(`Jev calls: ${rs.map(r => `${r.title} ${r.calls}`).join(', ')}; cost: ${rs.map(r => `${r.title} ${money(r.cost)}`).join(', ')}.`);
  lines.push('## Takeaways', '', ...takeaways.map(t => `- ${t}`), '');
  return lines.join('\n');
}

console.log(`\n  ${bold('Saved')} ${C.cyan(path.relative(ROOT, runDir))}`);
for (const f of fs.readdirSync(runDir)) console.log(`    ${dim('·')} ${f}`);
console.log('');
