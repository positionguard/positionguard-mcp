import type { Logger } from "./log.js";
import type { WireAreaCount, WireGroup, WireMember } from "./types.js";

// Thrown for any non-2xx response, and for transport failures (status 0).
// Carries the status so the tool layer can phrase it, and Retry-After on a
// 429 so the model is told to wait. Nothing here retries: the API rate-limits
// per key, and a retry storm from a tool call is the thing 429 exists to stop.
export class ApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface ClientOptions {
  apiKey: string;
  baseUrl: string;
  log: Logger;
  userAgent: string;
  fetch?: typeof fetch; // injectable for tests; defaults to the global
  timeoutMs?: number;
}

// The paths this server may fetch. `/groups/{id}/areas` is deliberately not
// among them: it returns center coordinates, and this server does not need
// geometry to answer any question it offers. Area names and IDs come from
// `/area-counts`, which is coordinate-free by contract. See README.
const FORBIDDEN_PATH = /\/areas(\?|$)/;

export class PositionGuardClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly log: Logger;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.log = opts.log;
    this.userAgent = opts.userAgent;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  // groups:read
  listGroups(): Promise<WireGroup[]> {
    return this.get<WireGroup[]>("/groups");
  }

  // presence:read
  listMembers(groupId: string): Promise<WireMember[]> {
    return this.get<WireMember[]>(`/groups/${encodeURIComponent(groupId)}/members`);
  }

  // counts:read — also the only source of area names and IDs.
  listAreaCounts(groupId: string): Promise<WireAreaCount[]> {
    return this.get<WireAreaCount[]>(`/groups/${encodeURIComponent(groupId)}/area-counts`);
  }

  private async get<T>(path: string): Promise<T> {
    if (FORBIDDEN_PATH.test(path)) {
      // Not reachable through the public methods; kept as a hard stop so a
      // future edit cannot add geometry by accident.
      throw new Error(`refusing to fetch ${path}: this server never requests area geometry`);
    }
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          "User-Agent": this.userAgent,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const kind = err instanceof Error ? err.name : "Error";
      this.log.warn(`GET ${path} -> network failure (${kind}, ${Date.now() - started}ms)`);
      throw new ApiError(0, `PositionGuard API unreachable (${kind}).`);
    }

    const ms = Date.now() - started;
    if (!res.ok) {
      // Drain without logging: the body of an error is still a body.
      await res.arrayBuffer().catch(() => undefined);
      const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
      this.log.warn(`GET ${path} -> ${res.status} (${ms}ms)`);
      throw new ApiError(res.status, describeStatus(res.status, retryAfter), retryAfter);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      this.log.warn(`GET ${path} -> ${res.status} unparseable body (${ms}ms)`);
      throw new ApiError(res.status, "PositionGuard API returned a response that was not JSON.");
    }
    if (!Array.isArray(body)) {
      this.log.warn(`GET ${path} -> ${res.status} unexpected shape (${ms}ms)`);
      throw new ApiError(res.status, "PositionGuard API returned an unexpected response shape.");
    }
    this.log.info(`GET ${path} -> ${res.status} (${body.length} items, ${ms}ms)`);
    return body as T;
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// The sentence the model sees. Statuses are named so the model can tell the
// user something true; none of them invite a guess about presence.
export function describeStatus(status: number, retryAfterSeconds?: number): string {
  switch (status) {
    case 401:
    case 403:
      return "PositionGuard rejected the API key (HTTP " + status + "). Check the key and its scopes.";
    case 404:
      return "PositionGuard returned 404: no such group, or the key's owner is not a member of it.";
    case 429:
      return (
        "PositionGuard rate limit reached (HTTP 429). " +
        (retryAfterSeconds !== undefined
          ? `Wait ${retryAfterSeconds}s before asking again.`
          : "Wait before asking again.")
      );
    default:
      return status >= 500
        ? `PositionGuard API error (HTTP ${status}). Try again later.`
        : `PositionGuard API returned HTTP ${status}.`;
  }
}
