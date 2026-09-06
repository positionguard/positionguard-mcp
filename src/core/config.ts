export const DEFAULT_API_BASE = "https://api.positionguardai.com/api/v1";
export const KEY_PREFIX = "pg_live_";

// The portal shows the first 16 characters of a key (`pg_live_` + 8) and
// stores nothing more of it. This server logs the same and nothing more.
export const KEY_DISPLAY_CHARS = 16;

export function keyDisplayPrefix(key: string): string {
  return key.slice(0, KEY_DISPLAY_CHARS);
}

// Accepts a key or explains, in one sentence, why it was refused. Pure, so
// the same check runs identically under Node and in a Worker.
export function checkApiKey(key: string | undefined): { ok: true } | { ok: false; reason: string } {
  if (!key || key.trim() === "") {
    return { ok: false, reason: "POSITIONGUARD_API_KEY is not set." };
  }
  if (key !== key.trim()) {
    return { ok: false, reason: "POSITIONGUARD_API_KEY has surrounding whitespace." };
  }
  if (!key.startsWith(KEY_PREFIX)) {
    return {
      ok: false,
      reason: `POSITIONGUARD_API_KEY must start with "${KEY_PREFIX}" (a PositionGuard developer key).`,
    };
  }
  return { ok: true };
}
