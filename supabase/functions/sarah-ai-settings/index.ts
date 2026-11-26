import { createClient } from "npm:@supabase/supabase-js@2";
import { getAIProviderAdapter } from "../_shared/ai/providerRegistry.ts";
import type { AIProviderGenerationConfig } from "../_shared/ai/providerTypes.ts";

type Json = Record<string, unknown>;
type GenerationConfig = {
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
};

const MAX_BODY_BYTES = 16 * 1024;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const respond = (status: number, body: Json) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const normalize = (value: unknown, max = 256) =>
  typeof value === "string" && value.length <= max ? value.trim() : "";

const genericAuthFailure = () =>
  respond(401, { ok: false, error: "ADMIN_SESSION_UNAVAILABLE" });

const isSuperAdminRole = (value: unknown) =>
  String(value || "").trim().toUpperCase().replace(/\s+/g, "_") === "SUPER_ADMIN";

const parseGenerationConfig = (value: unknown): GenerationConfig | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const allowed = new Set(["temperature", "maxOutputTokens", "timeoutMs"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return null;

  const result: GenerationConfig = {};
  if (input.temperature !== undefined) {
    if (typeof input.temperature !== "number" || !Number.isFinite(input.temperature) ||
      input.temperature < 0 || input.temperature > 2) return null;
    result.temperature = input.temperature;
  }
  if (input.maxOutputTokens !== undefined) {
    if (!Number.isInteger(input.maxOutputTokens) ||
      Number(input.maxOutputTokens) < 1 || Number(input.maxOutputTokens) > 65536) return null;
    result.maxOutputTokens = Number(input.maxOutputTokens);
  }
  if (input.timeoutMs !== undefined) {
    if (!Number.isInteger(input.timeoutMs) ||
      Number(input.timeoutMs) < 5000 || Number(input.timeoutMs) > 120000) return null;
    result.timeoutMs = Number(input.timeoutMs);
  }
  return result;
};





const readRequestBody = async (request: Request): Promise<Json | null> => {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return null;
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Json : null;
  } catch {
    return null;
  }
};

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return respond(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  const url = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("auth_supabase_secret_key") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ||
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
  if (!url || !serviceKey || !anonKey) {
    return respond(503, { ok: false, error: "SERVICE_UNAVAILABLE" });
  }

  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
  if (!bearer || bearer === anonKey) return genericAuthFailure();

  const body = await readRequestBody(request);
  if (!body) return respond(400, { ok: false, error: "INVALID_OR_OVERSIZED_REQUEST" });

  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${bearer}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await caller.auth.getUser(bearer);
  if (authError || !authData.user) return genericAuthFailure();

  // This RPC derives the admin identity from auth.uid() and validates the
  // registered account session. Never trust an admin ID supplied in the body.
  const { data: profile, error: profileError } = await caller.rpc("get_current_admin_profile");
  if (profileError || !profile || profile.authenticated !== true ||
    profile.is_admin !== true || profile.is_active !== true ||
    profile.auth_user_id !== authData.user.id) {
    return genericAuthFailure();
  }

  const permissions = Array.isArray(profile.permissions) ? profile.permissions : [];
  const canManageAI = isSuperAdminRole(profile.role) || permissions.includes("ai:manage");
  if (!canManageAI) return respond(403, { ok: false, error: "AI_MANAGE_PERMISSION_REQUIRED" });

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const action = normalize(body.action, 32);
  if (action === "read") {
    const { data, error } = await caller.rpc("sarah_ai_get_provider_config");
    if (error) return respond(503, { ok: false, error: "CONFIGURATION_UNAVAILABLE" });
    return respond(200, {
      ok: true,
      config: data ? {
        providerId: data.provider_id,
        modelId: data.model_id,
        generationConfig: data.generation_config || {},
        enabled: data.enabled === true,
        hasApiKey: data.has_api_key === true,
        updatedAt: data.updated_at,
      } : null,
    });
  }

  if (action === "save") {
    const providerId = normalize(body.providerId, 64);
    const modelId = normalize(body.modelId, 128).replace(/^models\//, "");
    const generationConfig = parseGenerationConfig(body.generationConfig ?? {});
    const apiKey = body.apiKey === undefined ? null : normalize(body.apiKey, 512);
    const adapter = getAIProviderAdapter(providerId);

    if (!adapter) return respond(400, { ok: false, error: "PROVIDER_NOT_IMPLEMENTED" });
    if (!adapter.validateModelId(modelId) || !generationConfig) {
      return respond(400, { ok: false, error: "INVALID_PROVIDER_CONFIGURATION" });
    }
    if (body.apiKey !== undefined && (!apiKey || apiKey.length < 20)) {
      return respond(400, { ok: false, error: "INVALID_API_KEY_FORMAT" });
    }

    const { data, error } = await caller.rpc("sarah_ai_save_provider_config", {
      p_provider_id: providerId,
      p_model_id: modelId,
      p_endpoint_url: null,
      p_generation_config: generationConfig,
      p_api_key: apiKey,
    });
    if (error) {
      const message = String(error.message || "");
      if (message.includes("API key is required")) {
        return respond(400, { ok: false, error: "API_KEY_REQUIRED" });
      }
      return respond(400, { ok: false, error: "PROVIDER_CONFIGURATION_REJECTED" });
    }
    return respond(200, { ok: true, saved: true, config: data });
  }

  if (action === "test") {
    const { data: configRow, error: configError } = await caller.rpc("sarah_ai_get_provider_config");
    if (configError || !configRow || configRow.enabled !== true) {
      return respond(400, { ok: false, error: "PROVIDER_NOT_CONFIGURED" });
    }
    const adapter = getAIProviderAdapter(configRow.provider_id);
    if (!adapter) return respond(400, { ok: false, error: "PROVIDER_NOT_IMPLEMENTED" });

    const { data: quota, error: quotaError } = await admin.rpc("sarah_ai_consume_quota", {
      p_actor_auth_user_id: authData.user.id,
      p_max_requests: 20,
      p_window_seconds: 3600,
    });
    if (quotaError || !quota || quota.allowed !== true) {
      return respond(quotaError ? 503 : 429, {
        ok: false,
        error: quotaError ? "AI_QUOTA_SERVICE_UNAVAILABLE" : "AI_RATE_LIMITED",
        retryAfterSeconds: 3600,
      });
    }

    const { data: secret, error: secretError } = await admin.rpc("sarah_ai_get_provider_secret");
    if (secretError || typeof secret !== "string" || !secret) {
      return respond(503, { ok: false, error: "PROVIDER_CREDENTIAL_UNAVAILABLE" });
    }

    const result = await adapter.testConnection({
      providerId: configRow.provider_id,
      modelId: configRow.model_id,
      generationConfig: (configRow.generation_config || {}) as AIProviderGenerationConfig,
    }, secret);
    return respond(200, {
      ok: true,
      connected: result.connected,
      providerId: configRow.provider_id,
      modelId: configRow.model_id,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  if (action === "clear") {
    const { data, error } = await caller.rpc("sarah_ai_clear_provider_config");
    if (error || data !== true) return respond(503, { ok: false, error: "PROVIDER_CONFIGURATION_CLEAR_FAILED" });
    return respond(200, { ok: true, cleared: true });
  }

  return respond(404, { ok: false, error: "UNKNOWN_ACTION" });
});
