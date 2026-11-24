import type {
  AIProviderAdapter,
  AIProviderProfile,
  AIProviderConnectionResult,
} from "./providerTypes.ts";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const mapGeminiError = (status: number) => {
  if (status === 400) return "MODEL_REQUEST_REJECTED";
  if (status === 401 || status === 403) return "GEMINI_API_KEY_REJECTED";
  if (status === 404) return "GEMINI_MODEL_NOT_FOUND";
  if (status === 429) return "GEMINI_QUOTA_OR_RATE_LIMIT";
  if (status >= 500) return "GEMINI_PROVIDER_UNAVAILABLE";
  return "GEMINI_CONNECTION_FAILED";
};

export const geminiProviderAdapter: AIProviderAdapter = {
  id: "gemini",
  displayName: "Google Gemini",
  capabilities: {
    text: true,
    structuredOutput: true,
    functionCalling: true,
    audioInput: "model-dependent",
  },
  validateModelId(modelId: string) {
    const normalized = modelId.replace(/^models\//, "");
    return /^[A-Za-z0-9._:-]{1,128}$/.test(normalized);
  },
  async testConnection(
    profile: AIProviderProfile,
    apiKey: string,
  ): Promise<AIProviderConnectionResult> {
    if (!this.validateModelId(profile.modelId) || !apiKey) {
      return { connected: false, error: "INVALID_PROVIDER_CONFIGURATION" };
    }
    const modelId = profile.modelId.replace(/^models\//, "");
    const timeoutMs = Math.min(
      Math.max(Number(profile.generationConfig.timeoutMs || 15000), 5000),
      120000,
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(
        `${GEMINI_API_BASE}/models/${encodeURIComponent(modelId)}`,
        {
          method: "GET",
          headers: { "x-goog-api-key": apiKey },
          signal: controller.signal,
        },
      );
      if (!response.ok) return { connected: false, error: mapGeminiError(response.status) };
      return { connected: true };
    } catch (error) {
      return {
        connected: false,
        error: error instanceof DOMException && error.name === "AbortError"
          ? "GEMINI_CONNECTION_TIMEOUT"
          : "GEMINI_CONNECTION_FAILED",
      };
    } finally {
      clearTimeout(timeout);
    }
  },
};
