/* ============================================================
 * pi-multivision — 把视觉分析能力包装成 pi 原生工具（配置化版）
 *
 * 让不支持视觉的主模型（如 DeepSeek）通过工具调用直接看图：
 * 模型调用 multivision(imagePath, prompt) → 扩展调用 vision 脚本
 * → 按用户配置文件指定的模型链及顺序尝试（失败自动切换下一个）
 * → 超时/重试/空响应兜底 → 返回视觉模型的文字描述。
 *
 * ## 配置（首次使用必须配置，扩展不内置任何默认模型）
 *
 * 扩展读取 JSON 配置文件，来源优先级：
 *   1. 环境变量 VISION_CONFIG 指向的文件
 *   2. ~/.pi/agent/pi-multivision.json
 *
 * 配置格式：
 * {
 *   "visionScript": "/path/to/vision.js",   // 必填：图片→文字 的脚本
 *   "configPath":   "/path/to/models.json", // 可选：传给脚本 --config（模型选择/顺序）
 *   "timeout":      240                     // 可选：单次请求超时秒数，默认 240
 * }
 *
 * vision 脚本协议（OpenAI 兼容视觉 API）：
 *   node vision.js <图片路径...> --prompt "问题" --json [--timeout 秒] [--config 路径]
 *   输出 JSON：{ "text": "...", "provider": "...", "model": "...", "usage": {...} }
 *
 * 模型选择与顺序在 configPath 指向的文件中配置：
 *   { "providers": {
 *       "first":  { "baseUrl": "...", "apiKey": "...", "defaultModel": "...", "models": [...] },
 *       "second": { ... }
 *     } }
 *   providers 对象键的顺序 = 尝试顺序，前面的失败自动切换下一个。
 *
 * 安装：pi install npm:pi-multivision
 * ============================================================ */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface ExtConfig {
  visionScript: string;
  configPath?: string;
  timeout?: number;
}

const DEFAULT_CONFIG = join(homedir(), ".pi", "agent", "pi-multivision.json");

function loadExtConfig(): { cfg: ExtConfig | null; error: string | null } {
  const envPath = process.env.VISION_CONFIG;
  const candidates: string[] = [];
  if (envPath) candidates.push(envPath);
  candidates.push(DEFAULT_CONFIG);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const cfg = JSON.parse(readFileSync(p, "utf8")) as Partial<ExtConfig>;
      if (!cfg.visionScript || typeof cfg.visionScript !== "string") {
        return { cfg: null, error: `配置文件缺少 visionScript 字段: ${p}` };
      }
      return { cfg: cfg as ExtConfig, error: null };
    } catch (e) {
      return { cfg: null, error: `配置文件解析失败 (${p}): ${(e as Error).message}` };
    }
  }
  return { cfg: null, error: null };
}

function firstUseGuide(): string {
  return [
    "⚠️ 未检测到 pi-multivision 配置（首次使用需要显式指定视觉模型，扩展不内置默认模型）：",
    "",
    "1) 创建配置文件（二选一）：",
    "   - 环境变量 VISION_CONFIG 指向任意路径",
    "   - 默认位置 ~/.pi/agent/pi-multivision.json",
    "",
    '   {"visionScript": "/path/to/vision.js", "configPath": "/path/to/models.json", "timeout": 240}',
    "   - visionScript（必填）：图片→文字 的脚本，协议：",
    '     node vision.js <图片...> --prompt "问题" --json [--timeout 秒] → 输出 { "text": "...", "provider": "...", "model": "..." }',
    "   - configPath（可选）：传给脚本的 --config，用于选择模型及顺序",
    "   - timeout（可选）：单次请求超时秒数，默认 240",
    "",
    "2) 模型选择与顺序在 configPath 文件里配置（providers 键的顺序即尝试顺序，失败自动切下一个）：",
    '   {"providers": {"first": {"baseUrl": "...", "apiKey": "...", "defaultModel": "...", "models": ["..."]}, "second": {...}}}',
    "",
    "3) 配置完成后 /reload 即可使用。",
  ].join("\n");
}

function runVision(script: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err ? (stderr || String(err)) : "";
        resolve({ ok: !err, stdout, stderr: e });
      },
    );
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "multivision",
    label: "Multivision",
    description:
      "分析本地图片文件并返回文字描述。当前模型无法直接看图片时使用：" +
      "传入图片路径（相对或绝对）和一个问题，工具会按 pi-multivision 配置的视觉模型链" +
      "（见 ~/.pi/agent/pi-multivision.json 或 VISION_CONFIG）分析图片并返回结果。" +
      "适合：描述图片内容、OCR 识别文字、检查 UI 截图、分析图表/流程图。",
    parameters: Type.Object({
      prompt: Type.String({
        description: "要问视觉模型的问题（例如：识别图中所有文字 / 描述界面布局 / 对比差异）",
      }),
      imagePath: Type.Optional(
        Type.String({ description: "单张图片路径（png/jpg/webp 等），或相对当前目录的路径" }),
      ),
      imagePaths: Type.Optional(
        Type.Array(Type.String(), { description: "多张图片路径，用于对比或综合分析" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const { cfg, error } = loadExtConfig();
      if (error) {
        return { content: [{ type: "text", text: `pi-multivision 配置错误：${error}` }], details: {} };
      }
      if (!cfg) {
        return { content: [{ type: "text", text: firstUseGuide() }], details: {} };
      }
      if (!existsSync(cfg.visionScript)) {
        return {
          content: [{ type: "text", text: `visionScript 不存在: ${cfg.visionScript}\n请检查配置文件（VISION_CONFIG 或 ~/.pi/agent/pi-multivision.json）` }],
          details: {},
        };
      }
      const prompt = params.prompt?.trim() || "请详细描述这张图片的内容，包括所有可见的文字、物体、界面元素、布局和颜色。";
      const paths: string[] = params.imagePaths?.length
        ? params.imagePaths
        : params.imagePath
          ? [params.imagePath]
          : [];
      if (paths.length === 0) {
        return {
          content: [{ type: "text", text: "错误：未提供图片路径，需要 imagePath（单图）或 imagePaths（多图）参数" }],
          details: {},
        };
      }

      const timeoutS = cfg.timeout || 240;
      const args = [...paths, "--prompt", prompt, "--json", "--timeout", String(timeoutS)];
      if (cfg.configPath) args.push("--config", cfg.configPath);

      const { ok, stdout, stderr } = await runVision(cfg.visionScript, args, timeoutS * 1000 + 60_000);
      if (!ok) {
        return {
          content: [{ type: "text", text: `视觉分析失败：${stderr || "未知错误"}` }],
          details: {},
        };
      }
      try {
        const j = JSON.parse(stdout) as { text: string; provider?: string; model?: string; usage?: unknown };
        return {
          content: [{ type: "text", text: j.text }],
          details: { provider: j.provider ?? "unknown", model: j.model ?? "unknown", usage: j.usage ?? null },
        };
      } catch {
        return { content: [{ type: "text", text: stdout || "（空输出）" }], details: {} };
      }
    },
  });
}
