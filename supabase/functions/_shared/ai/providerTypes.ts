export interface AIProviderGenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface AIProviderProfile {
  providerId: string;
  modelId: string;
  endpointUrl?: string | null;
  generationConfig: AIProviderGenerationConfig;
}

export interface AIProviderConnectionResult {
  connected: boolean;
  error?: string;
}

export interface AIProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: {
    text: boolean;
    structuredOutput: boolean;
    functionCalling: boolean;
    audioInput: "supported" | "model-dependent" | "unsupported";
  };
  validateModelId(modelId: string): boolean;
  testConnection(
    profile: AIProviderProfile,
    apiKey: string,
  ): Promise<AIProviderConnectionResult>;
}
