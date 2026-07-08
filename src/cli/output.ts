/**
 * Output conventions:
 *  - `--json` prints exactly one JSON document on stdout (agents parse this).
 *  - Human mode uses minimal color; respects --no-color, NO_COLOR, and non-TTY.
 *  - Spinners only in human TTY mode; suppressed under --json / CI / pipes.
 */

import pc from "picocolors";

export interface OutputContext {
  json: boolean;
  color: boolean;
  isTTY: boolean;
}

export function makeOutput(opts: { json?: boolean; color?: boolean }): OutputContext {
  const isTTY = Boolean(process.stdout.isTTY);
  const noColorEnv = Boolean(process.env.NO_COLOR);
  return {
    json: Boolean(opts.json),
    color: (opts.color ?? true) && !noColorEnv && isTTY,
    isTTY,
  };
}

const fmt = {
  dim: (out: OutputContext, s: string) => (out.color ? pc.dim(s) : s),
  bold: (out: OutputContext, s: string) => (out.color ? pc.bold(s) : s),
  green: (out: OutputContext, s: string) => (out.color ? pc.green(s) : s),
  red: (out: OutputContext, s: string) => (out.color ? pc.red(s) : s),
  yellow: (out: OutputContext, s: string) => (out.color ? pc.yellow(s) : s),
  cyan: (out: OutputContext, s: string) => (out.color ? pc.cyan(s) : s),
};
export { fmt };

/** Print a result: JSON document in --json mode, else the human renderer. */
export function emit(out: OutputContext, data: unknown, human?: (o: OutputContext) => void): void {
  if (out.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  if (human) {
    human(out);
    return;
  }
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function note(out: OutputContext, message: string): void {
  if (out.json) return; // never pollute the JSON document
  process.stderr.write(`${message}\n`);
}

/** Minimal spinner — stderr, TTY-only, no dependency on a TUI framework. */
export interface Spinner {
  update(text: string): void;
  stop(finalText?: string): void;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(out: OutputContext, text: string): Spinner {
  if (out.json || !process.stderr.isTTY) {
    return { update: () => {}, stop: () => {} };
  }
  let current = text;
  let frame = 0;
  const render = () => {
    process.stderr.write(`\r\x1b[2K${fmt.cyan(out, FRAMES[frame % FRAMES.length]!)} ${current}`);
    frame++;
  };
  render();
  const timer = setInterval(render, 90);
  timer.unref();
  return {
    update(next: string) {
      current = next;
    },
    stop(finalText?: string) {
      clearInterval(timer);
      process.stderr.write("\r\x1b[2K");
      if (finalText) process.stderr.write(`${finalText}\n`);
    },
  };
}

/** Two-column key/value block for human output. */
export function kv(out: OutputContext, rows: Array<[string, unknown]>): void {
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) {
    if (v === undefined || v === null || v === "") continue;
    process.stdout.write(`${fmt.dim(out, k.padEnd(width))}  ${String(v)}\n`);
  }
}

/** Simple aligned table for human output (no table dep). */
export function table(out: OutputContext, headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[], dim = false) => {
    const s = cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
    process.stdout.write(`${dim ? fmt.dim(out, s) : s}\n`);
  };
  line(headers, true);
  for (const row of rows) line(row);
}
