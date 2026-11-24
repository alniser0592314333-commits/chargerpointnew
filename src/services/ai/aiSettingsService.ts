import { config } from "../../config/env";
import { authService } from "../auth/authService";

export type SarahAIProviderId = "gemini";

export interface SarahAIGenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface SarahAIProviderConfig {
  providerId: SarahAIProviderId;
  modelId: string;
  generationConfig: SarahAIGenerationConfig;
  enabled: boolean;
  hasApiKey: boolean;
  updatedAt: string | null;
}

export interface SarahAIProviderStatus {
  connected: boolean;
  error?: string;
  providerId?: SarahAIProviderId;
  modelId?: string;
}

type GatewayResponse<T> = {
  ok: boolean;
  error?: string;
} & T;

const gatewayUrl = () => {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new Error("SUPABASE_NOT_CONFIGURED");
  }
  return `${config.supabaseUrl.replace(/\/+$/, "")}/functions/v1/sarah-ai-settings`;
};

const invoke = async <T extends Record<string, unknown>>(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<GatewayResponse<T>> => {
  const session = await authService.getSupabaseAuthSession();
  if (!session?.access_token) throw new Error("AUTH_SESSION_REQUIRED");

  let response: Response;
  try {
    response = await fetch(gatewayUrl(), {
      method: "POST",
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, ...payload }),
      cache: "no-store",
    });
  } catch {
    throw new Error("AI_SETTINGS_NETWORK_ERROR");
  }

  let result: GatewayResponse<T>;
  try {
    result = await response.json() as GatewayResponse<T>;
  } catch {
    throw new Error("AI_SETTINGS_INVALID_RESPONSE");
  }
  if (!response.ok || result.ok !== true) {
    throw new Error(result.error || "AI_SETTINGS_REQUEST_FAILED");
  }
  return result;
};

export const aiSettingsService = {
  async read(): Promise<SarahAIProviderConfig | null> {
    const result = await invoke<{ config: SarahAIProviderConfig | null }>("read");
    return result.config;
  },

  async save(input: {
    providerId: SarahAIProviderId;
    modelId: string;
    generationConfig: SarahAIGenerationConfig;
    apiKey?: string;
  }): Promise<void> {
    await invoke<{ saved: boolean }>("save", {
      providerId: input.providerId,
      modelId: input.modelId.trim(),
      generationConfig: input.generationConfig,
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    });
  },

  async test(): Promise<SarahAIProviderStatus> {
    const result = await invoke<{
      connected: boolean;
      providerId?: SarahAIProviderId;
      modelId?: string;
      error?: string;
    }>("test");
    return {
      connected: result.connected === true,
      providerId: result.providerId,
      modelId: result.modelId,
      error: result.error,
    };
  },

  async clear(): Promise<void> {
    await invoke<{ cleared: boolean }>("clear");
  },
};
