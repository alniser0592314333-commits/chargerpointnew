import { geminiProviderAdapter } from "./geminiProviderAdapter.ts";
import type { AIProviderAdapter } from "./providerTypes.ts";

const adapters: ReadonlyMap<string, AIProviderAdapter> = new Map([
  [geminiProviderAdapter.id, geminiProviderAdapter],
]);

export const getAIProviderAdapter = (providerId: string): AIProviderAdapter | null =>
  adapters.get(providerId) ?? null;

export const listAIProviderAdapters = (): AIProviderAdapter[] =>
  Array.from(adapters.values());
