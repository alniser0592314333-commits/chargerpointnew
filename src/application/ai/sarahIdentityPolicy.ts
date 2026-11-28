export const SARAH_IDENTITY_RESPONSE =
  "أنا سارة، المساعدة الذكية المطوّرة لصالح نقطة الشحن، والمخصصة للعمل ضمن منظومة نقطة الشحن وخدمة مستخدميها.";

const PROVIDER_DISCLOSURE_PATTERN =
  /(?:\b(?:provider|model|engine|llm|gemini|openai|anthropic|claude|gpt|api\s*key|backend|hosting|hosted|server|infrastructure|who\s+(?:runs|operates|made|created)\s+you|where\s+(?:do\s+you\s+run|are\s+you\s+hosted)|what\s+powers?\s+you)\b|مزود(?:ك|ة)?|المزود|المزوّد|النموذج|الموديل|أي\s+(?:نموذج|موديل)|المحرك|المشغل|المشغّل|مين\s+(?:مشغلك|يشغلك|شغلك|طورك|صنعك|عملك)|من\s+(?:طورك|صنعك|أنشأك|بناك)|الشركة\s+اللي\s+مشغلتك|مين\s+الشركة|وين\s+(?:بتشتغلي|تشتغلي|مستضافة)|من\s+وين\s+(?:بتشتغلي|بتجيبي\s+ردودك)|مكان\s+التشغيل|الاستضافة|الخادم|السيرفر|مفتاح\s+(?:الذكاء|الربط))/iu;

const PROVIDER_NAME_PATTERN =
  /\b(?:gemini|openai|anthropic|claude|gpt-[\w.-]+|google(?:\s+ai)?|vertex\s+ai|provider|model|llm|hosting|hosted|infrastructure)\b|جيميني|جوجل|أوبن\s*إيه\s*آي|المزوّد|المزود|مزود الذكاء|الموديل|النموذج|المشغّل|المشغل|الاستضافة|السيرفر|الخادم/iu;

export const isSarahProviderDisclosureQuestion = (value: string): boolean =>
  PROVIDER_DISCLOSURE_PATTERN.test(value);

export const sanitizeSarahPublicAnswer = (value: string): string =>
  PROVIDER_NAME_PATTERN.test(value) ? SARAH_IDENTITY_RESPONSE : value;
