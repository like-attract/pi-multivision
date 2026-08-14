<div align="center">

# 👁️ pi-multivision

**Give text-only [pi](https://github.com/earendil-works/pi-coding-agent) models vision**

_One native tool call — a multi-backend vision model chain with automatic fallback._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![npm](https://img.shields.io/npm/v/pi-multivision)](https://www.npmjs.com/package/pi-multivision)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

## The Problem

Some of the best coding models are blind. You paste a screenshot, a UI mock, or a diagram into pi — and a text-only model (DeepSeek, etc.) simply cannot see it. The `read` tool omits the image, and describing it yourself is a chore.

## The Solution

`pi-multivision` registers a **native tool** (`multivision`) that any text-only model can call directly — no remembering to use a skill, no shelling out manually. The extension hands the image to a vision-capable model and returns the text description as the tool result.

- **🔌 Multi-backend with auto-fallback** — Step-3.7-Flash (ModelScope) → GLM-4.6V-Flash (Zhipu) → Qwen3.6-Chat (USTC-LLM). If a backend is rate-limited, times out, or returns an empty response, the next one is tried automatically.
- **⏱️ Timeout & retry** — per-request timeout (240s default, configurable), rate-limit backoff, and empty-response fallback. Slow models fail fast with a clear message instead of hanging.
- **🖼️ Single or multiple images** — `imagePath` for one, `imagePaths` for comparison across several.
- **🧠 Model-driven** — the tool is described in the model's tool list, so the agent picks it automatically whenever it needs to "see" an image.
- **🔧 BYO vision script** — the extension shells out to a small vision script (default `~/.agents/skills/vision/vision.js`), overridable via the `VISION_SCRIPT` env var. Bring your own providers/keys.

## Installation

From npm (recommended):

```bash
pi install npm:pi-multivision
```

From GitHub:

```bash
pi install git:github.com/like-attract/pi-multivision
```

Then `/reload` (or restart pi).

## Requirements & Configuration

> **First use requires explicit configuration.** pi-multivision ships with **no default model** —
> your providers/keys stay in your own config files, nothing is baked into the extension.

### 1. Extension config (where the vision script lives)

The extension reads a JSON config, from either:

- `VISION_CONFIG` env var, or
- `~/.pi/agent/pi-multivision.json` (default)

```json
{
  "visionScript": "/path/to/vision.js",
  "configPath": "/path/to/models.json",
  "timeout": 240
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `visionScript` | ✅ | Script that turns image paths into a text description (protocol below) |
| `configPath` | — | Passed to the script as `--config` (model selection & order, see §2) |
| `timeout` | — | Per-request timeout in seconds (default 240) |

If no config is found, the tool returns a step-by-step setup guide instead of guessing.

### 2. Model selection & order (in the script's config)

The vision script reads its own model config (the file you pass via `configPath`).
**The key order of `providers` is the try order** — failures automatically fall through to the next:

```json
{
  "providers": {
    "first":  { "baseUrl": "https://.../v1", "apiKey": "sk-...", "defaultModel": "vision-model-a", "models": ["vision-model-a"] },
    "second": { "baseUrl": "https://.../v1", "apiKey": "sk-...", "defaultModel": "vision-model-b", "models": ["vision-model-b"] }
  }
}
```

### 3. vision script protocol

The script must accept:

```
node vision.js <image...> --prompt "question" --json [--timeout seconds] [--config path]
# stdout: { "text": "...", "provider": "...", "model": "...", "usage": {...} }
```

A minimal example script (OpenAI-compatible):

```js
#!/usr/bin/env node
// vision.js — base64 the image, POST to any vision-capable chat/completions API
const fs = require('fs');
(async () => {
  const args = process.argv.slice(2);
  const promptIdx = args.indexOf('--prompt');
  const prompt = promptIdx >= 0 ? args[promptIdx + 1] : 'Describe this image';
  const path = args.find((a) => !a.startsWith('--'));
  const b64 = fs.readFileSync(path).toString('base64');
  const r = await fetch('https://api.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.VISION_API_KEY },
    body: JSON.stringify({
      model: process.env.VISION_MODEL,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
      ]}],
    }),
  });
  const j = await r.json();
  console.log(JSON.stringify({ text: j.choices[0].message.content, provider: 'example', model: j.model }));
})().catch((e) => { console.error(e.message); process.exit(1); });
```

## Usage

Just ask. The model calls the tool itself:

```
> 看一下 login-page.png 里有什么文字
> 对比这两张截图有什么区别  (pass imagePaths)
```

Or force it in a session with any image path:

```
multivision(imagePath="screenshot.png", prompt="识别图中所有文字")
```

## Agent Usage Guidelines（模型行为准则）

Text-only models **must call `multivision` immediately, without waiting for the user to ask**, when any of these triggers occur:

1. **Image omitted from context** — the message shows `image omitted: model does not support images`, `(image omitted)`, `[图片已省略]`, or similar markers. This means the image was stripped because the model cannot see it natively.
2. **User supplied an image** — an image path, an image URL, or phrasing like "look at this screenshot / 看图 / 识图 / OCR / 看这个界面".
3. **A "seeing" task is involved** — UI screenshots, error dialogs, flowcharts, diagrams, scanned documents, multi-image comparison.
4. **User asks "what is this?"** while an image attachment is present in the conversation.

If the image path is unknown: search common locations first (`%TEMP%`, session dir, cwd) for `png/jpg/webp` files, then call the tool. If still not found, **ask the user for the path** rather than skipping the analysis.

> This guideline is also mirrored in the `vision` skill (SKILL.md) which is the canonical reference.

## Why not pi-vision-handoff?

[pi-vision-handoff](https://github.com/monotykamary/pi-vision-handoff) intercepts image blocks at the `context` event and swaps them for descriptions automatically — great if you want zero-visible-tool behavior. `pi-multivision` takes the opposite approach: an **explicit native tool** with a hardened multi-backend chain (timeout, retry, empty-response fallback) that the model calls on demand. Trade-off: you see the tool call in the transcript (auditable), and you keep full control over which backend is used.

## License

MIT
