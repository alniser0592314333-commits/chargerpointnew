import type { SarahAIProviderConfig } from "../../services/ai/aiSettingsService";

export const SARAH_INTEGRATION_PACKAGE_FORMAT = "chargerpointnew.sarah-integration";
export const SARAH_INTEGRATION_PACKAGE_VERSION = 1;

export interface SarahIntegrationPackage {
  format: typeof SARAH_INTEGRATION_PACKAGE_FORMAT;
  schemaVersion: typeof SARAH_INTEGRATION_PACKAGE_VERSION;
  exportedAt: string;
  assistant: {
    id: "sarah";
    name: "Sarah";
    role: "AI Operator";
    language: "ar-PS";
  };
  provider: {
    providerId: string;
    modelId: string;
    endpoint: string;
    apiKeyIncluded: false;
    apiKeyMustBeConfiguredSeparately: true;
    generationConfig: SarahAIProviderConfig["generationConfig"];
  };
  applicationContract: {
    application: "ChargerPointNew";
    executionBoundary: string;
    readBoundary: string;
    authorizationBoundary: string;
    synchronizationBoundary: string;
    toolCatalogVersion: string;
    toolSchemasIncluded: false;
  };
  behaviorRules: string[];
  securityRules: string[];
  offlineContract: {
    preExecutionQueueIsSeparateFromOutbox: true;
    preserveOriginalAudio: true;
    noCrossAccountExecution: true;
    pwaBackgroundExecution: "best-effort";
    apkBackgroundExecution: "native-worker-required";
  };
  capabilityRoadmap: string[];
  portabilityNotes: string[];
}

export const createSarahIntegrationPackage = (
  config: SarahAIProviderConfig,
): SarahIntegrationPackage => ({
  format: SARAH_INTEGRATION_PACKAGE_FORMAT,
  schemaVersion: SARAH_INTEGRATION_PACKAGE_VERSION,
  exportedAt: new Date().toISOString(),
  assistant: {
    id: "sarah",
    name: "Sarah",
    role: "AI Operator",
    language: "ar-PS",
  },
  provider: {
    providerId: config.providerId,
    modelId: config.modelId,
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyIncluded: false,
    apiKeyMustBeConfiguredSeparately: true,
    generationConfig: { ...config.generationConfig },
  },
  applicationContract: {
    application: "ChargerPointNew",
    executionBoundary: "All business mutations must call the existing application Use Cases and their repository transaction/outbox path. No model-generated SQL or direct business-table writes.",
    readBoundary: "Read tools must wrap existing read models and apply explicit permission checks before exposing any result to the model.",
    authorizationBoundary: "The authenticated admin identity, active account session, and effective server permissions are authoritative. Model output never grants access.",
    synchronizationBoundary: "The Sarah input queue ends when a validated tool enters the application. The existing Outbox and Sync Engine remain the only business-command synchronization path.",
    toolCatalogVersion: "0.1.0-foundation",
    toolSchemasIncluded: false,
  },
  behaviorRules: [
    "Understand Palestinian Arabic and ask only for missing information that blocks a safe action.",
    "Represent intent and tool arguments as validated structured data, never as executable SQL or free-form commands.",
    "Distinguish read-only requests, ordinary mutations, sensitive actions, and critical actions.",
    "Require explicit confirmation before sensitive operations and preserve the application's existing BIN verification flow.",
    "Never claim that a request succeeded based only on a model response; require application or server execution evidence.",
    "Explain uncertainty and distinguish confirmed root causes from hypotheses.",
    "Do not invent customer records, business rules, prices, balances, or permission grants.",
  ],
  securityRules: [
    "Never place provider API keys, Supabase service-role keys, access tokens, passwords, BIN, or PIN in model context, browser storage, APK assets, logs, or exports.",
    "Minimize customer data sent to the provider and omit phone numbers unless required for the task.",
    "Bind queued inputs, conversations, tool proposals, and execution results to one authenticated admin identity and device/session context.",
    "Re-check current permissions at tool execution time.",
    "Never bypass server-side authorization, customer/purchase ownership, financial FIFO allocation, or idempotency controls.",
    "Never delete outbox commands, replace an uncertain command ID, or retry a financial mutation with a new identity.",
  ],
  offlineContract: {
    preExecutionQueueIsSeparateFromOutbox: true,
    preserveOriginalAudio: true,
    noCrossAccountExecution: true,
    pwaBackgroundExecution: "best-effort",
    apkBackgroundExecution: "native-worker-required",
  },
  capabilityRoadmap: [
    "Orders and order items",
    "Customers and customer history",
    "Devices and pricing",
    "Business days",
    "Finance and payments",
    "Goals and requests",
    "Purchase Book with per-admin isolation",
    "Sync diagnostics and safe repair proposals",
    "Backup inspection (never automatic restore/reset)",
    "Notifications and events",
    "Customer portal and wallet services remain separately permissioned",
  ],
  portabilityNotes: [
    "This package contains the integration contract and non-secret provider profile, not executable access to the application.",
    "The receiving system needs a compatible provider adapter and a secure authenticated tool-execution bridge.",
    "Provider API credentials must be entered again in the receiving system; they are intentionally excluded.",
    "Tool JSON Schemas will be included as each capability is implemented and verified. This foundation package does not claim that the future tool catalog is complete.",
  ],
});
