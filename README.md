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

`pi-multivision` registers a **native tool** (`vision_tool`) that any text-only model can call directly — no remembering to use a skill, no shelling out manually. The extension hands the image to a vision-capable model and returns the text description as the tool result.

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

## Requirements

The extension needs a "vision script" that turns image paths into descriptions:

```
node vision.js <image...> --prompt "question" --json [--timeout seconds]
# stdout: { "text": "...", "provider": "...", "model": "...", "usage": {...} }
```

Default location: `~/.agents/skills/vision/vision.js` (the [pi vision skill](https://github.com/like-attract/pi-multivision#readme) layout). If yours lives elsewhere, point the extension at it:

```bash
export VISION_SCRIPT=/path/to/your/vision.js
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
vision_tool(imagePath="screenshot.png", prompt="识别图中所有文字")
```

## Configuration

| Setting | Where | Default |
|---------|-------|---------|
| Vision script path | `VISION_SCRIPT` env var | `~/.agents/skills/vision/vision.js` |
| Per-request timeout | edit `VISION_TIMEOUT_S` in `multivision.ts` | 240 s |

## Why not pi-vision-handoff?

[pi-vision-handoff](https://github.com/monotykamary/pi-vision-handoff) intercepts image blocks at the `context` event and swaps them for descriptions automatically — great if you want zero-visible-tool behavior. `pi-multivision` takes the opposite approach: an **explicit native tool** with a hardened multi-backend chain (timeout, retry, empty-response fallback) that the model calls on demand. Trade-off: you see the tool call in the transcript (auditable), and you keep full control over which backend is used.

## License

MIT
