// The logger the core writes to. Transports supply the implementation
// (stderr for stdio, where stdout is the protocol channel).
//
// What may be logged, from CLAUDE.md: paths, HTTP statuses, item counts,
// durations, tool names, the `status` a tool returned. Never a response
// body, never the key, never a member name. Tool arguments are not logged
// at all — `nickname` is a member name.
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
