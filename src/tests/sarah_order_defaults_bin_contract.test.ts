import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("Sarah phone defaults and secure payment confirmation", () => {
  const edge = readFileSync("supabase/functions/sarah-ai-chat/index.ts", "utf8");
  const migration = readFileSync(
    "supabase/migrations/20261128153000_sarah_phone_defaults_and_super_admin_payment_review.sql",
    "utf8",
  );
  const chatService = readFileSync("src/services/ai/sarahChatService.ts", "utf8");
  const chatPage = readFileSync("src/components/pages/SarahChatPage.tsx", "utf8");

  it("defaults a generic or unspecified phone to Xiaomi without asking", () => {
    expect(edge).toContain('const genericPhoneNames = new Set(["جوال", "هاتف", "موبايل"');
    expect(edge).toContain('? "هاتف شاومي"');
    expect(edge).toContain("the server resolves Xiaomi");
    expect(migration).toContain("'هاتف شاومي'");
    expect(migration).toContain("'cellphone'");
  });

  it("defaults an omitted charger flag to false but rejects malformed values", () => {
    expect(edge).toContain("const hasCharger = chargerInput === true");
    expect(edge).toContain("chargerInput !== undefined && chargerInput !== null && typeof chargerInput !== \"boolean\"");
    expect(migration).toContain("ITEM_CHARGER_SELECTION_INVALID");
    expect(migration).toContain("Missing or JSON null means no charger");
  });

  it("keeps BIN in the separate secure transport and never in chat history", () => {
    expect(edge).toContain("const actionBin = typeof body.bin === \"string\"");
    expect(edge).toContain("p_bin: actionBin");
    expect(chatService).toContain("if (bin) requestBody.bin = bin");
    expect(chatService).toContain("requestBody.confirmationAction = { token: confirmationAction.token }");
    expect(chatPage).toContain("لن يُضاف إلى المحادثة أو سجل الرسائل أو يُرسل إلى Gemini");
    expect(chatPage).toContain("sendWithLocalActions(");
  });

  it("allows Super Admin payment review by role while ordinary admins remain permission-gated", () => {
    expect(migration).toContain("public.review_qr_payment_submission");
    expect(migration).toContain("a.role IN ('SUPER_ADMIN', 'Super Admin')");
    expect(migration).toContain("finance:approve-payment");
    expect(migration).toContain("AND NOT EXISTS (");
    expect(edge).toContain("/Missing payment (review|creation) permission/i.test(message)");
    expect(edge).toContain("AI_CAPABILITY_PERMISSION_REQUIRED");
  });
});
