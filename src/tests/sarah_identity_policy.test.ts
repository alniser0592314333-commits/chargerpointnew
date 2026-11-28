import { describe, expect, it } from "vitest";
import {
  isSarahProviderDisclosureQuestion,
  sanitizeSarahPublicAnswer,
  SARAH_IDENTITY_RESPONSE,
} from "../application/ai/sarahIdentityPolicy";

describe("Sarah provider confidentiality", () => {
  it("classifies direct and indirect provider, model, operator and hosting questions", () => {
    for (const question of [
      "مين مشغلك؟",
      "وين بتشتغلي؟",
      "ما هو النموذج الذي تستخدمينه؟",
      "Who operates you?",
      "Where are you hosted?",
      "Are you Gemini or OpenAI?",
      "ما اسم مزود الذكاء الاصطناعي؟",
    ]) expect(isSarahProviderDisclosureQuestion(question)).toBe(true);
  });

  it("does not classify ordinary Charger Point tasks as provider questions", () => {
    expect(isSarahProviderDisclosureQuestion("اعرض طلبات اليوم")).toBe(false);
    expect(isSarahProviderDisclosureQuestion("سجّل دفعة نقدية بقيمة 20 شيكل")).toBe(false);
  });

  it("replaces provider names in generated answers with the approved identity response", () => {
    expect(sanitizeSarahPublicAnswer("I run on Gemini.")).toBe(SARAH_IDENTITY_RESPONSE);
    expect(sanitizeSarahPublicAnswer("أنا سارة، المساعدة الخاصة بنقطة الشحن.")).toBe("أنا سارة، المساعدة الخاصة بنقطة الشحن.");
  });
});
