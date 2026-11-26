import { geminiProviderAdapter } from "./geminiProviderAdapter.ts";

Deno.test("Gemini adapter validates model identifiers", () => {
  if (!geminiProviderAdapter.validateModelId("gemini-3.8-flash")) {
    throw new Error("Expected a valid Gemini model identifier to pass.");
  }
  if (!geminiProviderAdapter.validateModelId("models/gemini-3.8-flash")) {
    throw new Error("Expected a models/ resource name to pass.");
  }
  if (geminiProviderAdapter.validateModelId("../secrets")) {
    throw new Error("Path traversal model identifiers must be rejected.");
  }
});

Deno.test("Gemini adapter tests model access with a server-side API key header", async () => {
  const originalFetch = globalThis.fetch;
  let receivedHeader = "";
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    receivedHeader = new Headers(init?.headers).get("x-goog-api-key") || "";
    return new Response(JSON.stringify({ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const result = await geminiProviderAdapter.testConnection({
      providerId: "gemini",
      modelId: "gemini-3.8-flash",
      generationConfig: { timeoutMs: 5000 },
    }, "test-key-that-is-never-persisted-in-tests");
    if (!result.connected || receivedHeader !== "test-key-that-is-never-persisted-in-tests") {
      throw new Error("Expected the adapter to authenticate the model metadata request.");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Gemini adapter returns a sanitized invalid-key status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("sensitive provider response body", { status: 403 });
  try {
    const result = await geminiProviderAdapter.testConnection({
      providerId: "gemini",
      modelId: "gemini-3.8-flash",
      generationConfig: { timeoutMs: 5000 },
    }, "test-key-that-is-never-persisted-in-tests");
    if (result.connected || result.error !== "GEMINI_API_KEY_REJECTED") {
      throw new Error("Expected a sanitized invalid-key classification.");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
