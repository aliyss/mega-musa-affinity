# Mega Musa for Affinity

AI image generation and localized editing in an Affinity document: paste a region, describe
the change, and the result lands in the open document as a new layer. Models, pricing,
prompt handling, queue and spending tracking match the
[Photoshop edition](https://github.com/SphericalLabs/mega-musa) which was used as a reference.

## Why a local panel

Affinity's *Settings → Photoshop Plugins* loads `.8bf` filter binaries written against
Adobe's plugin API. It hosts no panels and no UXP extensions, so the Photoshop plugin can
never run there. Affinity 3.2 does ship a JavaScript scripting API, and this edition uses
it: a small Node server owns keys, provider requests and files, and a browser panel beside
the canvas provides the controls.

## Requirements

- Affinity Photo, Designer or Publisher (2.x or Affinity by Canva) on macOS, Windows or
  Linux/Wine.
- Node.js 18 or newer. No dependencies, no install step.
- A Gemini and/or OpenAI API key.

## Start

```bash
npm start                      # or: node bin/mega-musa-affinity.mjs
```

The panel opens at <http://127.0.0.1:4767/>. In a window 900 px or wider it fills the
viewport as an app shell: a settings rail, a work stage (canvas, references, prompt, queue)
with the **Generate** bar pinned to the bottom, and a history column that scrolls on its
own. From 1240 px all three sit side by side; below that the history moves under the
stage. Narrower windows fall back to a single scrolling column.

| Flag | Purpose |
| --- | --- |
| `--port <n>` | Local port (default 4767) |
| `--host <addr>` | Bind address (default `127.0.0.1`) |
| `--data-dir <path>` | Where settings, images and history live |
| `--no-open` | Do not open a browser window |

| Variable | Purpose |
| --- | --- |
| `MEGA_MUSA_HOME` | Data directory, same as `--data-dir` |
| `MEGA_MUSA_HANDOFF` | Folder shared with Affinity for placement |
| `MEGA_MUSA_AFFINITY_MCP` | Bridge URL (default `http://localhost:6767`) |

## Use

1. **Basic Settings**: paste the key for the model family you use and press **Save**. Only
   the selected model's key is ever sent.
2. In Affinity, select the area to change and copy it (**⌘C** / **Ctrl+C**).
3. In **Canvas from Affinity**, press **⌘V** / **Ctrl+V** (or drop an image). The pasted
   copy is what the model edits. Without a canvas, generation runs from the prompt and
   references only.
4. Write a prompt, choose model, resolution, quality and aspect ratio, add references.
5. **Generate** (or **⌘+Enter** / **Ctrl+Enter**).
6. Tick **Place results in Affinity automatically**, or press **Place in Affinity** on a
   finished result. **Copy image** pastes by hand; **Open in Affinity** opens the PNG as its
   own document.

### Placement

Placement runs through Affinity's own scripting bridge, the same one the MCP tools use:

1. Enable **Help → AI Automation** in Affinity, and leave the document you want open.
2. The server connects to the bridge on port 6767 and calls `execute_script` with a script
   that loads the newest result as an image node on the current spread of
   `Document.current`. No document is opened or created.
3. A failure never fails the generation: the result stays saved and the status line says
   what went wrong.

The script negotiates the bitmap's colour format from the open document (a CMYK document
refuses an RGBA bitmap), and stages the file into the shared handoff folder, because
Affinity under Wine can only read inside its own prefix and sees it as `C:\…`.

`affinity/mega-musa-place.js` is the same script for the manual route: enable *Settings →
Default Permissions → Access the file system*, add it under *Window → General → Scripts*,
and run it after generating. It reads `<handoff>/latest.png`.

### Editing part of a picture

Copy enough surrounding pixels for the model to blend the edit, then place the result back
over that area. Feathered selections need the surrounding pixels in the copy. Hide an
earlier result in Affinity before copying again if it should not influence the next edit.

The output is generated at a supported ratio; **Fit Canvas** sets the ratio picker to the
pasted copy's ratio.

### Variations

Brace groups queue one generation per combination:

| Prompt | Result |
| --- | --- |
| `a {red, blue} {balloon, car}` | Four prompts, one per combination |
| `{a photo of a {banana, strawberry}, 3}` | Three banana prompts and three strawberry prompts |

Use `\{`, `\}`, `\,` and `\\` for literal characters. A batch holds up to 10 images; a
batch that expands further, or is malformed, queues nothing.

### Queue and spending

Four jobs at most, two provider requests in flight. Each job keeps the prompt, settings,
canvas and references captured at **Generate**, so the controls stay editable while it
runs. Canceling before dispatch costs nothing; a request already sent is still billable and
keeps its estimate in the budget. Totals are tracked in USD and displayed in your currency
(rates from Frankfurter, cached for six hours).

### Recall

**Recent Generations** keeps prompt, model, settings, references and file for each result.
**Copy prompt** copies the text; **Load settings** restores the model, settings, prompt and
the original reference images.

## Data and privacy

- Keys, history and images live in `~/.mega-musa-affinity/`; `settings.json` is written with
  `0600` permissions. A browser panel has no secure-storage equivalent, so keys are plain
  text on this machine.
- Prompts and images go from this machine directly to Gemini or OpenAI. There is no Mega
  Musa server. Only a currency code is sent to Frankfurter.
- The server binds to `127.0.0.1`. Do not expose it to a network you do not trust: anyone
  who reaches it can spend your API credit.

Provider retention depends on your account settings: see
[Gemini data retention](https://ai.google.dev/gemini-api/docs/zdr) and
[OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data).

## Differences from the Photoshop plugin

| Photoshop edition | Affinity edition |
| --- | --- |
| Reads document, selection and artboards directly | Uses the pixels you copy from Affinity |
| Places a Smart Object with a linked mask | Pastes or places a raster layer; masks are made in Affinity |
| Blocks 32-bit/HDR, Quick Mask, Bitmap, Indexed and Multichannel documents | No document-mode checks; any document that can copy pixels works |
| Archives references in a hidden layer group | References live in the local data directory |
| Keys in UXP secure storage | Keys in `settings.json` (0600) |

## Tests

```bash
npm test
```

Covers prompt expansion, model geometry and pricing, settings normalization, the job queue,
persistence and budget arithmetic, the placement script and MCP session, and the HTTP API
end to end with mocked providers.

## Development

[ARCHITECTURE.md](ARCHITECTURE.md) documents module boundaries, the job lifecycle and the
HTTP API.

## License

[GPL version 3 only](LICENSE) with a
[Photoshop/UXP linking exception](LICENSE-EXCEPTION), inherited from the Photoshop plugin.
SPDX: `GPL-3.0-only WITH GPL-3.0-linking-exception`.
