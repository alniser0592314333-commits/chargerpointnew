import { config } from "../../config/env";
import { getFreshSupabaseAuthToken, getStoredSupabaseAuthSession } from "../supabase/client";

export interface SarahChatResponse {
  answer: string;
  modelId: string;
  requiresBin?: boolean;
  binError?: "BIN_INVALID";
}

const endpoint = () => {
  if (!config.supabaseUrl || !config.supabaseAnonKey) throw new Error("SUPABASE_NOT_CONFIGURED");
  return `${config.supabaseUrl.replace(/\/+$/, "")}/functions/v1/sarah-ai-chat`;
};

const tokenSubject = (token: string): string => {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return "";
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
    return typeof payload.sub === "string" ? payload.sub : "";
  } catch {
    return "";
  }
};

export const sarahChatService = {
  async send(
    text: string,
    expectedAuthUserId: string,
    history: { role: "user" | "assistant"; text: string }[] = [],
    requestId?: string,
    bin?: string,
  ): Promise<SarahChatResponse> {
    const clean = text.trim();
    if (!clean) throw new Error("TEXT_REQUIRED");
    if (clean.length > 20000) throw new Error("TEXT_TOO_LARGE");
    if (!expectedAuthUserId) throw new Error("AUTH_IDENTITY_REQUIRED");

    // Capture and re-check the selected Auth identity around token refresh.
    // Account switches can occur while getFreshSupabaseAuthToken awaits a refresh.
    const before = getStoredSupabaseAuthSession();
    if (before?.user?.id !== expectedAuthUserId) throw new Error("ACCOUNT_CHANGED");

    const session = await getFreshSupabaseAuthToken();
    if (!session.token) throw new Error(session.reason || "AUTH_SESSION_REQUIRED");

    const after = getStoredSupabaseAuthSession();
    if (tokenSubject(session.token) !== expectedAuthUserId || after?.user?.id !== expectedAuthUserId) {
      throw new Error("ACCOUNT_CHANGED");
    }

    const stableRequestId = requestId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)
      ? requestId
      : crypto.randomUUID();

    if (bin !== undefined && (!/^\\d{4,}$/.test(bin) || bin.length > 32)) throw new Error("BIN_FORMAT_INVALID");

    const requestBody: Record<string, unknown> = {
      text: clean,
      history: history.slice(-20),
      requestId: stableRequestId,
    };
    // BIN is sent only as a separate transport field; never added to chat text/history.
    if (bin) requestBody.bin = bin;

    let response: Response;
    try {
      response = await fetch(endpoint(), {
        method: "POST",
        headers: {
          apikey: config.supabaseAnonKey,
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json",
        },
        // Stable across retries of the same queued message; used only for server-side
        // action idempotency and never included in the Gemini prompt/history.
        body: JSON.stringify(requestBody),
        cache: "no-store",
      });
    } catch {
      throw new Error("AI_SETTINGS_NETWORK_ERROR");
    }

    let data: Record<string, unknown>;
    try {
      data = await response.json();
    } catch {
      throw new Error("AI_SETTINGS_INVALID_RESPONSE");
    }
    if (response.status === 428 && data.error === "BIN_REQUIRED") {
      return { answer: "", modelId: "", requiresBin: true };
    }
    if (response.status === 403 && data.error === "BIN_INVALID") {
      return { answer: "", modelId: "", requiresBin: true, binError: "BIN_INVALID" };
    }
    if (!response.ok || data.ok !== true) {
      throw new Error(typeof data.error === "string" ? data.error : "AI_REQUEST_FAILED");
    }
    if (typeof data.answer !== "string" || typeof data.modelId !== "string") {
      throw new Error("AI_SETTINGS_INVALID_RESPONSE");
    }
    return { answer: data.answer, modelId: data.modelId };
  },
};
