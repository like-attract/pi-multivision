/* ============================================================
 * pi-multivision — 把视觉分析能力包装成 pi 原生工具（配置化版）
 *
 * 让不支持视觉的主模型（如 DeepSeek）通过工具调用直接看图：
 * 模型调用 multivision(imagePath, prompt) → 扩展调用包内置 vision 脚本
 * → 按 .env 配置的模型链及顺序尝试（失败自动切换下一个）
 * → 超时/重试/空响应兜底 → 返回视觉模型的文字描述。
 *
 * ## 配置（统一使用 .env，首次使用必须配置，扩展不内置任何模型 key）
 *
 * 配置来源：环境变量 VISION_ENV 指向的文件，或默认 ~/.pi/agent/pi-multivision.env
 *
 * 配置格式：
 *   VISION_MODEL_1_NAME=glm          // 可选：模型链名称（用于显示）
 *   VISION_MODEL_1_URL=...           // 必填：OpenAI 兼容 baseUrl
 *   VISION_MODEL_1_MODEL=glm-4.6v-flash // 必填：模型名
 *   VISION_MODEL_1_KEY=...           // 必填：API key
 *   VISION_MODEL_2_URL=...           // 可选：最多 10 个，序号=失败切换顺序
 *   VISION_TIMEOUT=240               // 可选：单次请求超时秒数，默认 240
 *
 * 安装：pi install npm:pi-multivision（包内置 vision.js，无需自备脚本）
 * ============================================================ */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface ExtConfig {
  visionScript: string;
  timeout?: number;
}

const DEFAULT_ENV = join(homedir(), ".pi", "agent", "pi-multivision.env");
const BUILTIN_VISION = fileURLToPath(new URL("./vision.js", import.meta.url));

function loadExtConfig(): { cfg: ExtConfig | null; error: string | null } {
  // 统一的配置来源：仅 .env（VISION_ENV 环境变量 → 默认 ~/.pi/agent/pi-multivision.env）
  const envFile = process.env.VISION_ENV || DEFAULT_ENV;
  if (!existsSync(envFile)) {
    return { cfg: null, error: null };
  }
  if (!existsSync(BUILTIN_VISION)) {
    return { cfg: null, error: "包内置 vision 脚本缺失（安装不完整，请重新 pi install）" };
  }
  return { cfg: { visionScript: BUILTIN_VISION }, error: null };
}

function firstUseGuide(): string {
  return [
    "⚠️ 未检测到 pi-multivision 配置。首次使用请创建 ~/.pi/agent/pi-multivision.env（或设置环境变量 VISION_ENV 指向其他路径）：",
    "",
    "  VISION_MODEL_1_NAME=glm",
    "  VISION_MODEL_1_URL=https://open.bigmodel.cn/api/paas/v4",
    "  VISION_MODEL_1_MODEL=glm-4.6v-flash",
    "  VISION_MODEL_1_KEY=<你的API key>",
    "",
    "  最多 10 个模型：VISION_MODEL_2_URL / _KEY / _MODEL ...（序号即失败切换顺序，前面失败自动切下一个）。",
    "  可选：VISION_TIMEOUT=240（单次请求超时秒数，默认 240）。",
    "  包内附带 pi-multivision.env.example 模板（GLM / Qwen / Step 占位）。",
    "  免费/低价视觉模型推荐：GLM-4.6V-Flash（https://open.bigmodel.cn/api/paas/v4）、Step-3.7-Flash（ModelScope 网关）。",
    "",
    "配置完成后重新发起即可，无需 /reload。",
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
  // 视觉能力判断：模型声明 input 包含 "image" 时原生支持识图，
  // 此时图片附件对模型直接可见，不应再调用 multivision 重复分析
  const modelSupportsVision = (model: { input?: string[] } | undefined): boolean =>
    Array.isArray(model?.input) && model.input.includes("image");

  // 按当前模型能力同步 multivision 的激活状态：
  // 模型有视觉 → 停用（模型看不到该工具）；模型无视觉 → 确保启用
  const syncMultivisionTool = (model: { input?: string[] } | undefined) => {
    try {
      const active = pi.getActiveTools();
      const enabled = active.includes("multivision");
      const vision = modelSupportsVision(model);
      if (vision && enabled) {
        pi.setActiveTools(active.filter((name) => name !== "multivision"));
      } else if (!vision && !enabled) {
        pi.setActiveTools([...active, "multivision"]);
      }
    } catch {
      /* 工具列表不可用时忽略 */
    }
  };

  pi.on("session_start", (_event, ctx) => syncMultivisionTool(ctx.model));
  pi.on("model_select", (event) => syncMultivisionTool(event.model));

  pi.registerTool({
    name: "multivision",
    label: "Multivision",
    promptSnippet:
      "Analyze local images via a vision model chain: describe content, OCR text, inspect UI screenshots, charts and diagrams. Use automatically when images are attached, an image path/URL is given, or the user asks to view/inspect/compare images.",
    description:
      "分析本地图片文件并返回文字描述。注意：仅当图片对你（模型）不可见时才调用本工具——" +
      "例如图片以 'image omitted / model does not support images / 图片已省略' 标记出现，或你只能拿到图片路径。" +
      "若图片已作为附件直接可见、你能直接看到图片内容，说明当前模型原生支持识图，禁止调用本工具。" +
      "【强制触发条件：出现以下任一情况必须立即调用本工具，无需用户提醒】" +
      "1) 消息中的图片显示为 image omitted / model does not support images / 图片已省略 等标记（说明图片被省略，你无法直接查看）；" +
      "2) 用户提供了图片路径、图片 URL，或要求查看截图/图表/识图/OCR；" +
      "3) 上下文涉及 UI 截图、报错弹窗、流程图、多图对比等需要'看'的场景；" +
      "4) 用户问'这是什么/看看这个'而上下文里有图片附件。" +
      "若没有图片路径，先搜索 Temp 目录、会话目录、当前目录中的 png/jpg/webp 截图再调用；找不到则主动询问用户。" +
      "用法：传入图片路径（相对或绝对）和一个问题，工具会按 pi-multivision 配置的视觉模型链" +
      "（见 ~/.pi/agent/pi-multivision.env 或 VISION_ENV）分析图片并返回结果。" +
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const { cfg, error } = loadExtConfig();
      if (error) {
        return { content: [{ type: "text", text: `pi-multivision 配置错误：${error}` }], details: {} };
      }
      if (!cfg) {
        return { content: [{ type: "text", text: firstUseGuide() }], details: {} };
      }
      if (!existsSync(cfg.visionScript)) {
        return {
          content: [{ type: "text", text: `visionScript 不存在: ${cfg.visionScript}\n安装不完整，请重新 pi install npm:pi-multivision` }],
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

      // 进度显示：pi-web/TUI 支持 setWidget（编辑器上方/下方）与 setStatus（状态栏）
      const names = paths.map((p) => p.split(/[\\/]/).pop() ?? p).join(", ");
      const showProgress = () => {
        try {
          ctx.ui.setWidget("multivision", [
            "◆ 视觉分析中",
            `  图片: ${names}`,
            `  模型链请求中（超时 ${timeoutS}s，失败自动切换）`,
          ]);
          ctx.ui.setStatus("multivision", "视觉分析中…");
        } catch {
          /* UI 不可用时忽略 */
        }
      };
      const clearProgress = () => {
        try {
          ctx.ui.setWidget("multivision", undefined);
          ctx.ui.setStatus("multivision", undefined);
        } catch {
          /* ignore */
        }
      };

      showProgress();
      try {
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
      } finally {
        clearProgress();
      }
    },
  });
}
