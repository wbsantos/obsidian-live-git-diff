/**
 * log.ts — one logging surface, so the debug toggle actually means something.
 *
 * `debug` is silent unless the user turns it on in settings. `warn`/`error` are
 * ALWAYS on: a plugin that hides its own failures behind a toggle is how you get a
 * silent no-op that looks like a feature that doesn't work. The rule this encodes is
 * the same one the base pane follows — never let a failure look like an empty result.
 */
const PREFIX = '[live-git-diff]';

let enabled = false;

export function setDebug(v: boolean): void {
  enabled = !!v;
}

export function isDebug(): boolean {
  return enabled;
}

export function debug(...args: unknown[]): void {
  if (enabled) console.log(PREFIX, ...args);
}

export function warn(...args: unknown[]): void {
  console.warn(PREFIX, ...args);
}

export function error(...args: unknown[]): void {
  console.error(PREFIX, ...args);
}
