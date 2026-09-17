// Video post-processing for versus runs (needs ffmpeg and ffprobe on PATH).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PAGE = { width: 1100, height: 760 };
const FAST_SPEED = 4;
const END_HOLD_S = 3; // both side-by-side videos hold their final frame this long

export const hasFfmpeg = () => spawnSync('ffmpeg', ['-version']).status === 0;

const run = args => spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: 'inherit' }).status === 0;
const encode = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
const duration = file => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout) || 0;

/**
 * Filter that restores the full page. When windows are tiled with --force-device-scale-factor, Playwright records
 * the page shrunk by that factor into the top-left of a 1100×760 frame (the rest is grey); crop it and scale it back.
 */
const restorePage = contentScale => contentScale < 0.999
  ? `crop=${Math.round(PAGE.width * contentScale)}:${Math.round(PAGE.height * contentScale)}:0:0,scale=${PAGE.width}:${PAGE.height},`
  : '';

/**
 * Builds <profile>.mp4 for each result with a <profile>.webm in runDir, then side-by-side.mp4 and side-by-side-fast.mp4.
 * `results` are versus summary results (profile, title, result, guessesUsed, calls, rejected, cost, finishedMs, videoStartMs).
 * Returns { sideBySide, sideBySideFast } as file names, or null for any that weren't made.
 */
export function buildVideos(runDir, results, { contentScale = 1 } = {}) {
  const out = { sideBySide: null, sideBySideFast: null };
  const videos = [];
  for (const r of results) {
    const webm = path.join(runDir, `${r.profile}.webm`);
    if (!fs.existsSync(webm)) continue;
    const mp4 = path.join(runDir, `${r.profile}.mp4`);
    const filter = restorePage(contentScale).replace(/,$/, '');
    if (run(['-i', webm, ...(filter ? ['-vf', filter] : []), ...encode, mp4])) videos.push({ ...r, mp4 });
  }
  if (videos.length < 2) return out;

  const durations = videos.map(r => duration(r.mp4));
  const longest = Math.max(...durations);
  const font = ['C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/arial.ttf'].find(f => fs.existsSync(f));
  const fontArg = font ? `fontfile='${font.replace(':', '\\:')}':` : '';
  const clean = s => s.replace(/[:'\\%,]/g, ' ');
  const resultLabel = r => clean({
    won: `solved in ${r.guessesUsed}`, lost: 'out of guesses', stuck: `gave up on guess ${r.guessesUsed + 1}`,
    timeout: 'stopped at time limit', closed: 'window closed', error: 'error',
  }[r.result] + ` · ${r.calls} calls · ${r.rejected} rejected · $${r.cost.toFixed(4)}`);

  // Each column: hold the last frame until the longest game ends, crop to the board and Jev panel, add a title and
  // a result line that appears when that game finishes.
  const filters = videos.map((r, i) => {
    const resultAt = Math.max(0, ((r.finishedMs ?? 0) - (r.videoStartMs ?? 0)) / 1000 - 1.5);
    return `[${i}:v]tpad=stop_mode=clone:stop_duration=${(longest - durations[i] + 0.5).toFixed(2)},crop=800:760:300:0,` +
      'pad=800:860:0:90:color=0x121213,' +
      `drawtext=${fontArg}text='${clean(r.title)}':expansion=none:x=(w-text_w)/2:y=14:fontsize=32:fontcolor=white,` +
      `drawtext=${fontArg}text='${resultLabel(r)}':expansion=none:x=(w-text_w)/2:y=56:fontsize=22:fontcolor=0x6aaa64:enable='gte(t,${resultAt.toFixed(2)})'[v${i}]`;
  });
  const sideBySide = path.join(runDir, 'side-by-side.mp4');
  if (!run([...videos.flatMap(r => ['-i', r.mp4]), '-filter_complex',
    `${filters.join(';')};${videos.map((_, i) => `[v${i}]`).join('')}hstack=inputs=${videos.length},scale=1920:-2,` +
    `tpad=stop_mode=clone:stop_duration=${END_HOLD_S}[out]`,
    '-map', '[out]', ...encode, sideBySide])) return out;
  out.sideBySide = path.basename(sideBySide);

  // Fast version: normal speed until ~2.5s after the first game shows its result (its end event lands about 2s after
  // the final board, which the engine holds on screen), then 4× until the games end, then its own end hold.
  const gamesEnd = longest + 0.5; // the composite's length before its end hold
  const speedFrom = Math.min(...videos.map(r => ((r.finishedMs ?? Infinity) - (r.videoStartMs ?? 0)) / 1000)) + 0.5;
  if (Number.isFinite(speedFrom) && longest - speedFrom > 5) {
    const fast = path.join(runDir, 'side-by-side-fast.mp4');
    if (run(['-i', sideBySide, '-filter_complex',
      `[0:v]split=2[a][b];[a]trim=0:${speedFrom.toFixed(2)},setpts=PTS-STARTPTS[a1];` +
      `[b]trim=start=${speedFrom.toFixed(2)}:end=${gamesEnd.toFixed(2)},setpts=(PTS-STARTPTS)/${FAST_SPEED},fps=25,` +
      `drawtext=${fontArg}text='${FAST_SPEED}x speed':expansion=none:x=w-text_w-24:y=h-text_h-18:fontsize=28:fontcolor=white:box=1:boxcolor=0x000000@0.6:boxborderw=10[b1];` +
      `[a1][b1]concat=n=2:v=1:a=0,tpad=stop_mode=clone:stop_duration=${END_HOLD_S}[out]`,
      '-map', '[out]', ...encode, fast])) out.sideBySideFast = path.basename(fast);
  }
  return out;
}
