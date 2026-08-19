#!/usr/bin/env node
// Vision — 调用视觉大模型描述/分析图片（多后端模型链，失败自动切换）
// 用法: node vision.js <图片路径或URL> [更多图片...] [--prompt "问题"] [--provider qwen|glm] [--model 模型名] [--json] [--config 配置文件路径] [--env .env路径]
//
// 配置来源优先级：
//   1. --config 显式指定的 JSON 配置文件（providers 对象，含 baseUrl/apiKey/defaultModel/models）
//   2. .env 文件（VISION_MODEL_1_URL/_KEY/_MODEL/_NAME，序号即尝试顺序；默认读 ~/.pi/agent/pi-multivision.env）
//   3. 脚本同目录的 config.json
const fs = require('fs');
const path = require('path');
const os = require('os');

function loadEnvProviders(envPath) {
  if (!envPath || !fs.existsSync(envPath)) return null;
  let raw;
  try { raw = fs.readFileSync(envPath, 'utf8'); }
  catch { return null; }
  const vars = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    vars[m[1]] = v.replace(/^#.*$/, '').trim();
  }
  const providers = {};
  let found = false;
  for (let i = 1; i <= 10; i++) {
    const url = vars[`VISION_MODEL_${i}_URL`];
    if (!url) continue;
    const key = vars[`VISION_MODEL_${i}_KEY`] || '';
    const model = vars[`VISION_MODEL_${i}_MODEL`] || 'default';
    const name = vars[`VISION_MODEL_${i}_NAME`] || `vision-${i}`;
    providers[name] = { name, baseUrl: url, apiKey: key, defaultModel: model, models: [model] };
    found = true;
  }
  return found ? providers : null;
}

function loadConfig(cfgPath, envPath) {
  // 1. 显式 --config
  if (cfgPath) {
    if (!fs.existsSync(cfgPath)) { console.error(`配置文件不存在: ${cfgPath}`); process.exit(1); }
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
    catch (e) { console.error(`配置文件解析失败 (${cfgPath}): ` + e.message); process.exit(1); }
  }
  // 2. .env（显式路径 → 默认 ~/.pi/agent/pi-multivision.env → 脚本同目录 .env）
  const envCandidates = [
    envPath,
    path.join(os.homedir(), '.pi', 'agent', 'pi-multivision.env'),
    path.join(__dirname, '.env'),
  ].filter(Boolean);
  for (const p of envCandidates) {
    const providers = loadEnvProviders(p);
    if (providers) return { providers, _source: `env:${p}` };
  }
  // 3. 同目录 config.json（兼容旧用法）
  const p = path.join(__dirname, 'config.json');
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { console.error(`配置文件解析失败 (${p}): ` + e.message); process.exit(1); }
  }
  // 环境变量覆盖 GLM key
  if (process.env.GLM_API_KEY) {
    const cfg = { providers: {} };
    cfg.providers.glm = { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: process.env.GLM_API_KEY, defaultModel: 'glm-4.6v-flash', models: ['glm-4.6v-flash'] };
    return cfg;
  }
  return { providers: {} };
}

function parseArgs(argv) {
  const files = [];
  let prompt = null, model = null, provider = null, json = false, maxTokens = 1500, timeout = 240000, config = null, env = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prompt' || a === '-p') prompt = argv[++i];
    else if (a === '--model' || a === '-m') model = argv[++i];
    else if (a === '--provider') provider = argv[++i];
    else if (a === '--json') json = true;
    else if (a === '--max-tokens') maxTokens = parseInt(argv[++i], 10) || 1500;
    else if (a === '--timeout') timeout = parseInt(argv[++i], 10) * 1000;
    else if (a === '--config') config = argv[++i];
    else if (a === '--env') env = argv[++i];
    else files.push(a);
  }
  return { files, prompt, model, provider, json, maxTokens, timeout, config, env };
}

function toDataUrl(file) {
  if (/^https?:\/\//.test(file)) return file;
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error('文件不存在: ' + abs);
  const buf = fs.readFileSync(abs);
  if (buf.length > 10 * 1024 * 1024) throw new Error(`图片太大 (${(buf.length / 1048576).toFixed(1)} MB)，最大 10 MB`);
  const ext = path.extname(abs).toLowerCase();
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' }[ext] || 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callApi(provName, provCfg, model, content, maxTokens, timeoutMs) {
  const base = (provCfg.baseUrl || '').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const retries = 4;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provCfg.apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: maxTokens }),
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        // 超时不重试：慢模型重试只会成倍拉长等待
        throw new Error(`${provName}/${model} 错误: 请求超时（${timeoutMs / 1000}s），可加 --timeout 秒数 调大`);
      }
      lastErr = e.message;
      if (attempt < retries) { await sleep(3000 * (attempt + 1)); continue; }
      throw new Error(`${provName}/${model} 错误: ${lastErr}`);
    }
    clearTimeout(timer);
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.choices) {
      return { text: j.choices[0].message.content, model: j.model, usage: j.usage, provider: provName };
    }
    const msg = (j.error && j.error.message) || `HTTP ${r.status}`;
    if (r.status === 429 && attempt < retries) { // 限流则退避重试
      lastErr = msg;
      await sleep(12000 * (attempt + 1));
      continue;
    }
    throw new Error(`${provName}/${model} 错误: ${msg}`);
  }
  throw new Error(`${provName}/${model} 限流重试失败: ${lastErr}`);
}

async function main() {
  const { files, prompt, model, provider, json, maxTokens, timeout, config, env } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(config, env);
  const providers = cfg.providers || {};
  const names = Object.keys(providers);
  if (names.length === 0) {
    console.error('未配置任何视觉模型。\n  - 方式一：创建 ~/.pi/agent/pi-multivision.env，填写 VISION_MODEL_1_URL / VISION_MODEL_1_KEY / VISION_MODEL_1_MODEL（序号=尝试顺序）\n  - 方式二：用 --config 指定 JSON 配置（providers 对象，见包内 config.example.json）');
    process.exit(1);
  }
  if (files.length === 0) {
    console.error('用法: node vision.js <图片路径或URL> [更多图片...] [--prompt "问题"] [--provider qwen|glm] [--model 模型名] [--json] [--config 路径] [--env 路径]');
    process.exit(1);
  }

  // 构建候选 (providerName, modelId)
  const candidates = [];
  if (model) {
    let found = false;
    for (const [pn, pc] of Object.entries(providers)) {
      if ((pc.models || []).includes(model)) { candidates.push([pn, model]); found = true; }
    }
    if (!found) { console.error(`模型 ${model} 未在任何 provider 中配置，可用模型: ${names.map(n => providers[n].models || []).flat().join(', ')}`); process.exit(1); }
  } else if (provider) {
    const pc = providers[provider];
    if (!pc) { console.error(`provider ${provider} 不存在，可用: ${names.join(', ')}`); process.exit(1); }
    candidates.push([provider, pc.defaultModel || (pc.models || [])[0]]);
  } else {
    // auto：按配置顺序取每个 provider 的默认模型，失败自动切下一个
    for (const [pn, pc] of Object.entries(providers)) {
      const dm = pc.defaultModel || (pc.models || [])[0];
      if (dm) candidates.push([pn, dm]);
    }
  }

  const content = [];
  content.push({ type: 'text', text: prompt || '请详细描述这张图片的内容，包括所有可见的文字、物体、界面元素、布局和颜色。' });
  for (const f of files) content.push({ type: 'image_url', image_url: { url: await toDataUrl(f) } });

  const errors = [];
  for (const [pn, m] of candidates) {
    try {
      const res = await callApi(pn, providers[pn], m, content, maxTokens, timeout);
      const text = (res.text || '').trim();
      if (!text) {
        // 偶发空响应：视为失败，继续尝试下一候选
        errors.push(`${pn}/${m}: 返回空内容`);
        continue;
      }
      if (json) console.log(JSON.stringify({ text, provider: pn, model: res.model, usage: res.usage }, null, 2));
      else console.log(text);
      return;
    } catch (e) {
      errors.push(`${pn}/${m}: ${e.message}`);
    }
  }
  console.error('所有后端都失败了:\n' + errors.map(e => '  - ' + e).join('\n'));
  process.exit(1);
}

main().catch(e => { console.error(e.message); process.exit(1); });