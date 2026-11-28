export const SARAH_IDENTITY_RESPONSE =
  "أنا سارة، المساعدة الذكية المطوّرة لصالح نقطة الشحن، والمخصصة للعمل ضمن منظومة نقطة الشحن وخدمة مستخدميها.";

const PROVIDER_DISCLOSURE_PATTERN =
  /(?:\b(?:provider|engine|llm|gemini|openai|anthropic|claude|gpt|api\s*key|backend|hosting|hosted|server|infrastructure|who\s+(?:runs|operates|made|created)\s+you|where\s+(?:do\s+you\s+run|are\s+you\s+hosted)|what\s+(?:ai\s+)?model\s+(?:powers|do\s+you\s+use)|which\s+model\s+are\s+you)\b|ai\s+model|language\s+model|مزود(?:ك|ة)?|المزود|المزوّد|مزود الذكاء|النموذج الذي تستخدمينه|أي\s+(?:نموذج|موديل)\s+تستخدمين|الموديل الذي تعملين عليه|المحرك الذي تعملين عليه|مين\s+(?:مشغلك|يشغلك|شغلك|طورك|صنعك|عملك|برمجك)|من\s+(?:طورك|صنعك|أنشأك|بناك|برمجك)|الشركة\s+اللي\s+مشغلتك|مين\s+الشركة|وين\s+(?:بتشتغلي|تشتغلي|مستضافة)|من\s+وين\s+(?:بتشتغلي|بتجيبي\s+ردودك)|مكان\s+التشغيل|الاستضافة|الخادم|السيرفر|مفتاح\s+(?:الذكاء|الربط))/iu;

const PROVIDER_NAME_PATTERN =
  /\b(?:gemini|openai|anthropic|claude|gpt-[\w.-]+|google(?:\s+ai)?|vertex\s+ai)\b|جيميني|جوجل\s*(?:اي|للذكاء)|أوبن\s*إيه\s*آي/iu;

const PROVIDER_DISCLOSURE_ANSWER_PATTERN =
  /\b(?:powered\s+by|running\s+on|hosted\s+by|the\s+model\s+i\s+use|my\s+provider|my\s+model|language\s+model|ai\s+model)\b|مزود الذكاء|المزوّد|المزود|الشركة المشغلة|المشغّل الذي أعمل معه|النموذج الذي أعمل عليه|مستضافة لدى/iu;

export const isSarahProviderDisclosureQuestion = (value: string): boolean =>
  PROVIDER_DISCLOSURE_PATTERN.test(value);

export const sanitizeSarahPublicAnswer = (value: string): string =>
  PROVIDER_NAME_PATTERN.test(value) || PROVIDER_DISCLOSURE_ANSWER_PATTERN.test(value)
    ? SARAH_IDENTITY_RESPONSE
    : value;
