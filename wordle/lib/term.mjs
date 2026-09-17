// Terminal styling shared by the CLI and the versus dashboard (24-bit ANSI colors).
const esc = s => `\x1b[${s}m`;
export const rgb = (r, g, b) => s => `${esc(`38;2;${r};${g};${b}`)}${s}${esc(39)}`;
export const bgRgb = (r, g, b) => s => `${esc(`48;2;${r};${g};${b}`)}${s}${esc(49)}`;
export const bold = s => `${esc(1)}${s}${esc(22)}`;
export const dim = s => `${esc(2)}${s}${esc(22)}`;
export const strike = s => `${esc(9)}${s}${esc(29)}`;

export const C = {
  green: rgb(106, 170, 100), yellow: rgb(201, 180, 88), grey: rgb(130, 130, 134), white: rgb(248, 248, 248),
  accent: rgb(167, 139, 250), red: rgb(240, 100, 100), cyan: rgb(110, 200, 220),
};
export const TILE_BG = {
  correct: bgRgb(83, 141, 78), present: bgRgb(181, 159, 59), absent: bgRgb(58, 58, 60),
  tbd: bgRgb(86, 87, 88), empty: bgRgb(32, 32, 34), rejected: bgRgb(150, 55, 55),
};
export const tile = (letter, state) => TILE_BG[state](bold(C.white(` ${(letter || ' ').toUpperCase()} `)));

export const visibleLen = s => s.replace(/\x1b\[[0-9;]*m/g, '').length;
export const pad = (s, n) => s + ' '.repeat(Math.max(0, n - visibleLen(s)));
export const bar = (p, width = 16, color = C.accent) => {
  const eighths = Math.round(Math.min(1, Math.max(0, p)) * width * 8), whole = Math.floor(eighths / 8);
  const part = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'][eighths % 8];
  return color('█'.repeat(whole) + part) + dim('·'.repeat(width - whole - (part ? 1 : 0)));
};
export const secs = ms => `${(ms / 1000).toFixed(1)}s`;
export const pct = p => `${Math.round(p * 100)}%`.padStart(4);
export const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
export const FEEDBACK = {
  correct: { icon: '●', color: C.green },
  present: { icon: '◐', color: C.yellow },
  absent: { icon: '○', color: C.grey },
};

export function box(title, lines, width = 76) {
  const out = [C.accent(`╭─ ${bold(title)} ${'─'.repeat(Math.max(0, width - visibleLen(title) - 3))}╮`)];
  for (const l of lines) out.push(`${C.accent('│')} ${pad(l, width - 2)} ${C.accent('│')}`);
  out.push(C.accent(`╰${'─'.repeat(width)}╯`));
  return out;
}

export const BANNER = [
  '     ██╗███████╗██╗   ██╗',
  '     ██║██╔════╝██║   ██║',
  '     ██║█████╗  ██║   ██║   ' + dim('plays'),
  '██   ██║██╔══╝  ╚██╗ ██╔╝   ' + bold('W O R D L E'),
  '╚█████╔╝███████╗ ╚████╔╝ ',
  ' ╚════╝ ╚══════╝  ╚═══╝  ',
].map((l, i) => '  ' + rgb(150 + i * 15, 120 + i * 8, 250)(l));
