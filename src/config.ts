import { getModel, type Model } from "@mariozechner/pi-ai";

/**
 * 模型解析。
 *
 * 优先读环境变量，缺省走 DeepSeek（pi-ai 内置 provider，只需 DEEPSEEK_API_KEY）。
 * 也支持任何 OpenAI 兼容端点（百炼 compatible-mode、vLLM、LM Studio 等）。
 */
export function resolveModel(): Model<any> {
  const provider = process.env.RELATIONSHIP_MODEL_PROVIDER?.trim();
  const modelId = process.env.RELATIONSHIP_MODEL_ID?.trim();

  const baseUrl = process.env.RELATIONSHIP_MODEL_BASE_URL?.trim();
  if (baseUrl) {
    // 自定义 OpenAI 兼容端点：pi-ai 按 provider 名取 key，这里统一映射到 OPENAI_API_KEY
    const apiKey =
      process.env.RELATIONSHIP_MODEL_API_KEY ??
      process.env.DASHSCOPE_API_KEY ??
      process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("配置了 RELATIONSHIP_MODEL_BASE_URL 但没有找到 API key");
    }
    process.env.OPENAI_API_KEY = apiKey;

    return {
      id: modelId ?? "qwen-plus",
      name: `${modelId ?? "qwen-plus"} (custom)`,
      api: "openai-completions",
      provider: "openai",
      baseUrl,
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 8192,
    };
  }

  if (process.env.DEEPSEEK_API_KEY) {
    return getModel("deepseek", (modelId ?? "deepseek-v4-pro") as never);
  }

  if (provider && modelId) {
    return getModel(provider as never, modelId as never);
  }

  throw new Error(
    "没有可用的模型配置：设置 DEEPSEEK_API_KEY，或 RELATIONSHIP_MODEL_BASE_URL + RELATIONSHIP_MODEL_API_KEY",
  );
}

/** Node 20.12+ 内置 .env 读取，不额外引 dotenv。 */
export function loadEnv(): void {
  try {
    process.loadEnvFile?.(".env");
  } catch {
    // 没有 .env 就用进程环境变量，正常情况
  }
}