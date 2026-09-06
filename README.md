# positionguard-mcp

An MCP server that lets an AI assistant ask about [PositionGuard](https://positionguardai.com)
presence: *is Earl at the skatepark*, *who is at home*, *how many people are
at the club*. It answers only what each member has agreed to share with
assistants, and says **unknown** when they haven't.

The server is a deterministic client of the public REST API. It holds one
API key, calls three read-only endpoints, and maps what comes back into a
small, explicit vocabulary. There is no model inside it and no privileged
access: every guarantee is enforced at `api.positionguardai.com`, where the
key is checked and the consent gate runs. This server cannot widen what the
API returns. It can only ask.

## What it asks for, and what it doesn't

This server gives the assistant less than it could, on purpose, and you can
read exactly what.

- **Three scopes, not four.** Grant `presence:read`, `counts:read` and
  `groups:read`. Do **not** grant `areas:read`: it unlocks
  `/groups/{id}/areas`, which returns area center coordinates, and this
  server never calls it. Area names and IDs come from `/area-counts`, which
  is coordinate-free by design. The client refuses to fetch `/areas` even
  if a future edit asked it to, and a test checks the refusal.
- **An Assistant key, not an Integration key.** Create the key in the
  developer portal with type **Assistant**. Members are visible to an
  Assistant key only if they have turned on *Let AI agents see whether I'm
  at an area*; otherwise the key gets *unknown*. An Integration key works
  mechanically, and bypasses that consent gate. That is the key holder's
  choice to make; the reference configuration does not demonstrate it.
- **Never log a body, a key, or a name.** Log lines carry paths, HTTP
  statuses, item counts, durations, tool names and the `status` a tool
  returned. The key appears once at startup, as its first 16 characters,
  the same prefix the portal shows.
- **`unknown` is not "away".** A member who has not opted in, who is in
  Ghost mode, who paused sharing, or whose phone has not reported in a
  while all look identical on the wire, and all map to `unknown`. The tool
  descriptions tell the model, in so many words, that `unknown` means it
  doesn't know. A stale last-known position is never returned as a
  location; counts include stale members and say so.
- **No caching.** The API caches for 15 seconds. A second cache would be a
  second place for a withdrawn consent to lag.
- **Read-only.** No write tools, no coordinates, no messages, no history.
  Every tool is annotated `readOnlyHint`.

## Tools

Every answer is JSON with a `status` field. `ok` means the question was
answered. `unknown` means it was not, and `reason` says why in one word.
API failures are MCP tool errors carrying the HTTP status in one sentence,
and are never retried.

| Tool | Scope | Answers |
|---|---|---|
| `list_groups` | `groups:read` | `{status, groups: [{group_id, name, group_type}]}` |
| `list_areas` | `counts:read` | `{status, areas: [{area_id, name, group_id, group_name}]}` — names only, no counts, no geometry |
| `where_is_member` | `presence:read` | `{status: "at_area", area, since}` \| `{status: "not_at_area"}` \| `{status: "unknown", reason}` |
| `who_is_at_area` | `presence:read` | `{status, area, members: [nickname…], undisclosed_note?}` — disclosed members only |
| `count_members_at_area` | `counts:read` | `{status, member_count, stale_count, undisclosed_count, note}` |

`where_is_member` looks a nickname up case-insensitively, in one group or
across all of them. Its `reason` is `not_disclosed`, `stale`, or
`no_such_member` (which is an answer, not an error, so the model doesn't
invent one). `member_count` is a floor when `undisclosed_count` or
`stale_count` is non-zero, and the `note` says to report it as "at least
N". When the API provides no count at all (public groups, archived areas),
the answer is `unknown` with reason `count_unavailable`, never zero.

How the wire maps to `status` is written out in `src/core/mapping.ts` and
tested against captured responses in `test/fixtures/` before any model
sees the server.

## Configuration

| Env | Required | Default |
|---|---|---|
| `POSITIONGUARD_API_KEY` | yes | — must start with `pg_live_`; the server refuses to start otherwise |
| `POSITIONGUARD_API_BASE` | no | `https://api.positionguardai.com/api/v1` |
| `TRANSPORT` | no | `http` (streamable HTTP + SSE) or `stdio` |
| `PORT` | no | `8788` (HTTP transports) |
| `HOST` | no | `0.0.0.0` (HTTP transports); use `127.0.0.1` outside a container |

On startup the server calls `GET /groups` once. A 401 or 403 exits with a
message naming the fix. An empty group list starts with a warning. Every
tool call re-checks the key, so a briefly unreachable API at startup is
logged and not fatal.

## Transports

One code path, three ways in. There is **no authentication** on the HTTP
transports in this version: run the server on a private docker network or
on localhost, and do not expose it.

| Path | Transport | For |
|---|---|---|
| `/mcp` | Streamable HTTP, stateless | Open WebUI |
| `/sse` (+ `/messages`) | SSE | Home Assistant's `mcp` integration, which is SSE-only |
| stdio (`TRANSPORT=stdio`) | stdio | Claude Desktop and other launchers |
| `/healthz` | — | docker healthcheck; returns `{"ok":true}` |

## Setups

Each setup is marked **tested** or **untested**. Only tested setups describe
behaviour that has actually been observed with this server.

### 1. Open WebUI + Anthropic + this server, in containers — untested

`docker-compose.example.yml` runs Open WebUI and this server on one private
network with no port published for the server. Put `WEBUI_SECRET_KEY` and
`POSITIONGUARD_API_KEY` in a `.env` file (gitignored), then:

```
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

In Open WebUI: **Admin → Settings → Connections**, add an OpenAI-compatible
connection with base URL `https://api.anthropic.com/v1` and your Anthropic
key. **Admin → Settings → External Tools**, add an MCP server of type
Streamable HTTP at `http://positionguard-mcp:8788/mcp` with auth **None**
(Bearer with an empty key sends an empty header, which servers reject).
Open WebUI has supported Streamable HTTP MCP servers natively since 0.6.31.

Disclosure for this and any other cloud-model setup: presence you've chosen
to disclose is sent to the model provider to produce answers.

### 2. Claude Desktop, stdio — untested

Build once (`npm install && npm run build`), then add to Claude Desktop's
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "positionguard": {
      "command": "node",
      "args": ["/absolute/path/to/positionguard-mcp/dist/index.js"],
      "env": {
        "POSITIONGUARD_API_KEY": "pg_live_…",
        "TRANSPORT": "stdio"
      }
    }
  }
}
```

When the package is published, `"command": "npx", "args": ["-y", "positionguard-mcp"]`
replaces the path. Logs go to stderr; stdout is the protocol.

### 3. Home Assistant Assist + `mcp` integration + this server — untested

Run the server with the HTTP transport where Home Assistant can reach it.
Add the **Model Context Protocol** integration and give it the SSE URL,
`http://<host>:8788/sse`. The tools appear under the conversation agent;
enable them for the agent (Anthropic, OpenAI, Ollama, …) you use with
Assist. Home Assistant's client is SSE-only and offers OAuth or nothing for
authentication, so this server's no-auth SSE endpoint is used as-is, on a
network you control.

### 4. Home Assistant Assist + Ollama + this server, fully local — untested

As 3, with Ollama as the conversation agent. No presence leaves your
network.

### 5. Open WebUI + Ollama, fully local — untested

As 1, with Ollama as the model connection instead of Anthropic. No presence
leaves your network.

## Rate limits and errors

The API rate-limits per key. A 429 is surfaced to the model as a tool error
that says how long to wait (from `Retry-After`), and the server does not
retry. The same holds for every other non-2xx status: one request, one
answer or one error, nothing in between.

## Development

```
npm install
npm test          # builds, then unit + end-to-end tests over all three transports
npm run dev       # runs from source (tsx)
```

`src/core/` holds the tools, the wire-to-status mapping and the API client.
It imports nothing Node-specific — `fetch` and `AbortSignal` only — and a
test enforces that, so the same core can run in a Cloudflare Worker with
the SDK's web-standard transport when a hosted version is wanted.
`src/transports/` is the Node side: streamable HTTP, SSE and stdio.

`test/fixtures/` holds one response per wire state (`test/fixtures/README.md`
lists them and their provenance). `npm run capture -- <group_id>` prints
redacted responses from a live API for refreshing them; use a synthetic
test group.

## Why isn't the app open source too?

The components that mediate access are auditable: this server, the Home
Assistant integration, the Hubitat app. You can read exactly what each one
requests and confirm it asks for less than it could. The hosted service is
not open, because the engine inside it — years of drift handling, debounce,
staleness distinction, clustering, the visibility layer — is the product,
and it is also what makes honest refusal affordable. A system that guesses
cannot say "I don't know"; it would be saying it constantly. Wrapping a
REST API in MCP is a weekend. Presence that does not flap is not.

## License

MIT. See `LICENSE`.
