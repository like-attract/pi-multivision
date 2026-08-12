/* ============================================================
 * pi-vision-tool — 把视觉分析能力包装成 pi 原生工具
 *
 * 让不支持视觉的主模型（如 DeepSeek）通过工具调用直接看图：
 * 模型调用 vision_tool(imagePath, prompt) → 扩展调用 vision.js
 * → 多后端自动切换（Step-3.7-Flash → GLM-4.6V → Qwen3.6，可配）
 * → 超时/重试/空响应兜底 → 返回视觉模型的文字描述。
 *
 * 依赖：一个"vision 脚本"（默认 ~/.agents/skills/vision/vision.js），
 * 可用环境变量 VISION_SCRIPT 覆盖为任意兼容脚本。
 * vision 脚本约定（OpenAI 兼容 API）：
 *   node vision.js <图片路径...> --prompt "问题" --json [--timeout 秒]
 *   输出 JSON：{ "text": "...", "provider": "...", "model": "...", "usage": {...} }
 *
 * 安装：pi install git:github.com/like-attract/pi-vision-tool
 * ============================================================ */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";

function resolveVisionScript(): string {
  const env = process.env.VISION_SCRIPT;
  if (env) return env;
  return join(homedir(), ".agents", "skills", "vision", "vision.js");
}

const VISION_TIMEOUT_S = 240;    // vision 脚本单次请求超时（秒）
const SPAWN_TIMEOUT_MS = 300_000; // 进程级兜底超时，需大于上面

interface VisionResult {
  text: string;
  provider?: string;
  model?: string;
  usage?: unknown;
}

function runVision(script: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      { timeout: SPAWN_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err ? (stderr || String(err)) : "";
        resolve({ ok: !err, stdout, stderr: e });
      },
    );
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "vision_tool",
    label: "Vision",
    description:
      "分析本地图片文件并返回文字描述。当前模型无法直接看图片时使用：" +
      "传入图片路径（相对或绝对）和一个问题，工具会把图片交给视觉模型（Step-3.7-Flash，自动降级 GLM/Qwen）" +
      "分析并返回结果。适合：描述图片内容、OCR 识别文字、检查 UI 截图、分析图表/流程图。",
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
      const script = resolveVisionScript();
      if (!existsSync(script)) {
        return {
          content: [{
            type: "text",
            text: `视觉脚本不存在: ${script}。请安装 vision skill 或设置 VISION_SCRIPT 环境变量指向兼容脚本。`,
          }],
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

      const args = [...paths, "--prompt", prompt, "--json", "--timeout", String(VISION_TIMEOUT_S)];
      const { ok, stdout, stderr } = await runVision(script, args);

      if (!ok) {
        return {
          content: [{ type: "text", text: `视觉分析失败：${stderr || "未知错误"}` }],
          details: {},
        };
      }
      try {
        const j = JSON.parse(stdout) as VisionResult;
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
