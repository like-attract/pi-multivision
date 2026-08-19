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

- **🔌 Multi-backend with auto-fallback** — providers are tried in config order (e.g. Step-3.7-Flash → GLM-4.6V-Flash → Qwen-Chat). If a backend is rate-limited, times out, or returns an empty response, the next one is tried automatically.
- **⏱️ Timeout & retry** — per-request timeout (240s default, configurable), rate-limit backoff, and empty-response fallback. Slow models fail fast with a clear message instead of hanging.
- **🖼️ Single or multiple images** — `imagePath` for one, `imagePaths` for comparison across several.
- **🧠 Model-driven** — the tool is described in the model's tool list, so the agent picks it automatically whenever it needs to "see" an image.
- **📦 Bundled vision script** — the package ships a ready-to-use `vision.js` (OpenAI-compatible, multi-provider fallback). No custom script needed.

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

## Configuration（仅 .env）

> **First use requires at least one vision model.** The extension ships with a bundled script but **no default API keys**.

### 1. Create `~/.pi/agent/pi-multivision.env`（或设置 `VISION_ENV` 指向其他路径）

```
VISION_MODEL_1_NAME=glm
VISION_MODEL_1_URL=https://open.bigmodel.cn/api/paas/v4
VISION_MODEL_1_MODEL=glm-4.6v-flash
VISION_MODEL_1_KEY=your_api_key_here
```

- Up to 10 models: `VISION_MODEL_1_*`, `VISION_MODEL_2_*`, … — **the number is the fallback order** (failed providers are skipped automatically).
- Optional `VISION_TIMEOUT=<seconds>` (default 240) — per-request timeout.
- A template with common providers is shipped as **`pi-multivision.env.example`** inside the package.

### 2. Call it

That's it — the extension auto-uses the bundled `vision.js`, so no JSON config, no custom script, no `/reload` after setup.

If no `.env` is found, the tool returns a step-by-step setup guide instead of guessing.

Free/low-cost vision models that work out of the box:

- GLM-4.6V-Flash — `https://open.bigmodel.cn/api/paas/v4`
- Step-3.7-Flash — `https://api-inference.modelscope.cn/v1` (model id `stepfun-ai/Step-3.7-Flash`)

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

### Progress display

While the analysis is running, the extension shows live progress via the extension UI protocol (`ctx.ui.setWidget` / `ctx.ui.setStatus`): a widget panel and a status-bar entry in both pi TUI and pi-web:

```
◆ 视觉分析中
  图片: screenshot.png
  模型链请求中（超时 240s，失败自动切换）
```

The widget/status is cleared automatically when the tool finishes.

## Agent Usage Guidelines（模型行为准则）

The tool registers a `promptSnippet`, so it appears in the system prompt's **Available tools** list automatically — models see it without the user naming it explicitly.

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
