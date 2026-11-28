import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Sarah native Android SMS capability", () => {
  it("exposes SMS only to accounts with the dedicated live permission", () => {
    const edge = read("supabase/functions/sarah-ai-chat/index.ts");
    const adminUi = read("src/components/pages/AdminManagementPage.tsx");
    expect(edge).toContain('name: "send_sms"');
    expect(edge).toContain('requiredPermissionGroups: [["customers:send-sms"]]');
    expect(adminUi).toContain('key: "customers:send-sms"');
  });

  it("hands the exact requested phone and message to the existing Android SMS bridge", () => {
    const edge = read("supabase/functions/sarah-ai-chat/index.ts");
    const page = read("src/components/pages/SarahChatPage.tsx");
    expect(edge).toContain('error: "LOCAL_SMS_REQUIRED"');
    expect(edge).toContain('name: "send_sms"');
    expect(page).toContain("sendSmsUsingSystemDefaultSim(phone, messageText)");
    expect(page).toContain("sarah_ai_get_chat_access_context");
  });

  it("does not silently resend an SMS after an interrupted native submission", () => {
    const page = read("src/components/pages/SarahChatPage.tsx");
    expect(page).toContain('cached?.state === "submitted"');
    expect(page).toContain('cached?.state === "started"');
    expect(page).toContain("SMS_SUBMISSION_UNCERTAIN");
  });

  it("does not require a second user confirmation for the explicit send request", () => {
    const edge = read("supabase/functions/sarah-ai-chat/index.ts");
    expect(edge).toContain("send_sms, send immediately without asking for a second confirmation");
    expect(edge).toContain('confirmationName === "send_sms"');
  });
});
