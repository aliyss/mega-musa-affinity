# Mega Musa for Affinity — architecture

The Affinity edition splits the Photoshop plugin into two processes. A local Node
server owns credentials, provider requests, spending totals and files; the browser panel
owns the controls. They share the model catalog and prompt parser as plain ES modules, so
prices and model framing cannot drift between the two.

## Module map

| Location | Responsibility |
| --- | --- |
| `lib/models.mjs` | Model catalog, framing, settings normalization, pricing, quality labels |
| `lib/description-models.mjs`, `lib/money.mjs` | Describe catalog and display-only currency formatting |
| `lib/providers.mjs` | Gemini and OpenAI image/description adapters, API error mapping |
| `lib/prompt-expansion.mjs`, `lib/limits.mjs` | Brace-group expansion and generation limits |
| `lib/jobs.mjs` | Admission, concurrency slots and cancellation |
| `lib/server.mjs` | HTTP API, static panel, validation and the generation workflow |
| `lib/store.mjs`, `lib/budget.mjs` | Settings, history, reference/image files and spending counters |
| `lib/affinity.mjs` | Opening results in Affinity and revealing them in the file manager |
| `lib/affinity-mcp.mjs` | Affinity's scripting MCP client: unlocks `execute_script`, keeps one bridge session per endpoint and places an image as a layer |
| `public/` | Panel markup, styles and controller |
| `bin/mega-musa-affinity.mjs` | CLI entry point |

`lib/models.mjs`, `lib/description-models.mjs`, `lib/money.mjs`, `lib/limits.mjs` and
`lib/prompt-expansion.mjs` are imported by both Node and the browser, so they must stay
free of Node and DOM imports. The server serves them from `/lib/`.

## Reading, caching and sessions

- `lib/store.mjs` parses `settings.json`, `budget.json` and `history.json` once and keeps
them until it writes them itself; every read returns a copy, so no caller can alias the
cache. A second store on the same directory reads the files normally.
- `lib/affinity-mcp.mjs` keeps one MCP session per endpoint, because opening one costs
three round trips (SSE stream, `initialize`, hint and preamble) and placement is usually a
single call. A session Affinity closed underneath it is dropped from the cache and
replaced once. `server.close()` closes the session, otherwise the open stream would keep
the process alive.
- `/api/place` and the auto-place hook share one code path, so a manual placement and an
automatic one behave identically.

## Generation flow

1. The panel captures the prompt, model settings, canvas copy and references and posts them to `/api/generate`.
2. The server normalizes settings against the model spec, validates the inputs, resolves the provider key and expands brace groups (at most 10 prompts, at most four queued jobs).
3. References are written once per content hash before any request is sent, so recall can reuse them even if generation fails.
4. Each expanded prompt becomes a job captured with its own settings, key, canvas bytes and references; later panel edits cannot change work already submitted.
5. `JobQueue` runs at most two provider requests at a time. The adapter reports dispatch immediately before the first potentially billable request.
6. On success the charge is recorded before the image is decoded or written, so a local failure cannot lose the billing record. The image is saved under `images/`, then the history entry is appended.
7. On cancellation before dispatch nothing is charged. After dispatch the estimate is recorded as a canceled request, which mirrors the Photoshop behaviour where provider cancellation cannot be confirmed.

## HTTP API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/state` | Settings (keys reduced to booleans), budget, jobs, history, paths |
| `POST /api/settings` | Keys, currency, model, model preferences, canvas preference, app name |
| `POST /api/generate` | Validate and queue generation |
| `GET /api/jobs`, `POST /api/jobs/:id/cancel`, `POST /api/jobs/cancel-all` | Queue inspection and cancellation |
| `POST /api/describe` | Describe images into prompt text |
| `POST /api/budget/reset` | Start a new spending period |
| `GET /api/rates?currency=` | Cached display exchange rate |
| `GET /api/images/:file`, `GET /api/references/:file` | Saved results and stored references |
| `POST /api/open`, `POST /api/reveal` | Open a result in Affinity, reveal it in the file manager |

Paths from requests are reduced to their base name and resolved inside the data
directory, so a request cannot escape it. Static requests resolve inside `public/` or
`lib/` only.

## Host boundary

Everything host-specific lives in `public/app.js` and `lib/affinity.mjs`:

- Canvas pixels arrive through a paste or drop, because the panel cannot read Affinity directly.
- Results leave through the clipboard (`ClipboardItem`), by opening the saved file, by revealing it on disk, or through `affinity/mega-musa-place.js`, which reads `<Desktop>/Mega Musa/latest.png` and inserts it with the in-app scripting API.
- The optional app name setting is used for `open -a` on macOS; on Windows and Linux the platform opener is used.

Keeping these in two places means the generation core can be tested without a browser or
Affinity installed.

## Storage layout

```
<data-dir>/
  settings.json     # keys (0600), currency, model preferences
  budget.json       # USD total and disjoint counters
  history.json      # newest 100 generations with settings and reference list
  images/           # <job id>.<ext> plus latest.<ext> and latest.json for the Affinity script
  references/       # <sha256 prefix>.<ext>

<Desktop>/Mega Musa/  # copy of latest.<ext>/latest.json that the Affinity script reads
```

The Desktop path follows the native desktop when one exists, otherwise the signed-in user's
Desktop inside the Wine prefix (`~/.local/share/affinity-v3`, `~/.wine`);
`MEGA_MUSA_HANDOFF` overrides it.

## Behaviour that changes must preserve

- Only the selected model's key is sent, and keys are never returned by the API or logged.
- Prices and estimates come from `lib/models.mjs`; the panel formats but never invents them.
- A prompt that expands beyond the limit queues nothing.
- Cancellation before dispatch adds no charge; cancellation after dispatch keeps the estimate.
- History and references are written after the charge is recorded, so the ledger never depends on a successful save.
