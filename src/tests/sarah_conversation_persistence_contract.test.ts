import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const store = readFileSync("src/application/ai/sarahConversationStore.ts", "utf8");
const page = readFileSync("src/components/pages/SarahChatPage.tsx", "utf8");
const queue = readFileSync("src/application/ai/sarahInputQueue.ts", "utf8");
const app = readFileSync("src/App.tsx", "utf8");

describe("Sarah daily conversation persistence", () => {
  it("stores conversations by account and Palestine-local date in durable IndexedDB", () => {
    expect(store).toContain('const DAILY_STORE = "dailyConversations"');
    expect(store).toContain('indexedDB.open(DB, 3)');
    expect(store).toContain('keyPath: "id"');
    expect(store).toContain('createIndex("account_date", ["accountId", "date"]');
    expect(store).toContain("async ensureDaily(accountId: string, date: string, title: string)");
    expect(store).toContain("async listDaily(accountId: string)");
    expect(store).toContain("async loadDaily(accountId: string, date: string, title: string)");
  });

  it("migrates the existing single transcript into today's daily conversation", () => {
    expect(store).toContain('tx.objectStore(STORE).get(accountId)');
    expect(store).toContain("Array.isArray(legacy?.messages) ? legacy.messages : []");
    expect(store).toContain("daily.add(result)");
  });

  it("bounds transcript retention and rejects invalid account/date input", () => {
    expect(store).toContain("messages.length > 500");
    expect(store).toContain("ACCOUNT_REQUIRED");
    expect(store).toContain("INVALID_DAILY_CONVERSATION");
    expect(store).toContain("updatedAt");
  });

  it("hydrates and saves only the selected daily transcript for the active account", () => {
    expect(page).toContain("sarahConversationStore.loadDaily(accountId, selectedDate");
    expect(page).toContain("hydratedDate !== selectedDate");
    expect(page).toContain("sarahConversationStore.saveDaily(accountId, selectedDate, messages");
    expect(page).toContain("isCurrent(accountId, operation)");
    expect(page).toContain("dailyConversationTitle(selectedDate)");
  });

  it("associates every durable input with its original daily conversation", () => {
    expect(queue).toContain("conversationDate?: string");
    expect(page).toContain("conversationDate: selectedDate");
    expect(page).toContain('(item.conversationDate || gazaDateKey()) === selectedDate');
  });

  it("persists each assistant answer before marking its input complete", () => {
    const sendIndex = page.indexOf("const response = await sendWithLocalActions(\n          clean,");
    const sendSave = page.indexOf("sarahConversationStore.saveDaily(accountId, selectedDate, completedMessages", sendIndex);
    const sendComplete = page.indexOf('sarahInputQueue.transition(accountId, id, "COMPLETED")', sendIndex);
    const retryIndex = page.indexOf("const response = await sendWithLocalActions(\n        record.text,");
    const retrySave = page.indexOf("sarahConversationStore.saveDaily(accountId, selectedDate, completedMessages", retryIndex);
    const retryComplete = page.indexOf('sarahInputQueue.transition(accountId, record.id, "COMPLETED")', retryIndex);
    expect(sendIndex).toBeGreaterThan(-1);
    expect(sendSave).toBeGreaterThan(sendIndex);
    expect(sendComplete).toBeGreaterThan(sendSave);
    expect(retryIndex).toBeGreaterThan(-1);
    expect(retrySave).toBeGreaterThan(retryIndex);
    expect(retryComplete).toBeGreaterThan(retrySave);
  });

  it("clears only the selected day's transcript and advances its generation", () => {
    expect(store).toContain("async clearDaily(accountId: string, date: string, title: string)");
    expect(page).toContain("sarahConversationStore.clearDaily(accountId, selectedDate");
    expect(page).toContain("conversationGenerationRef.current = nextGeneration");
    expect(page).toContain("مسح محادثة هذا اليوم فقط");
  });

  it("keeps per-day cross-tab clear notifications scoped to the active date", () => {
    expect(store).toContain('new BroadcastChannel("sarah-conversation-clear")');
    expect(store).toContain("channel?.postMessage({ accountId, generation: nextGeneration, date })");
    expect(page).toContain("subscribeToClear");
    expect(page).toContain("notice.accountId !== accountId");
    expect(page).toContain("notice.date && notice.date !== selectedDate");
    expect(page).toContain("snapshot.generation >= conversationGenerationRef.current");
  });

  it("opens Sarah as a standalone authenticated workspace and exits back to the app home", () => {
    expect(app).toContain('onExit={() => navigate("/app", true)}');
    expect(app).toContain("parseRoute(currentPath).pathname === '/app/sarah'");
    expect(page).toContain("خروج من سارة");
    expect(page).toContain("فتح محادثات سارة");
  });

  it("shows only the latest seven daily chats initially and supports expansion", () => {
    expect(page).toContain("dailyConversations.slice(0, 7)");
    expect(page).toContain("إظهار المزيد");
    expect(page).toContain("startTodayConversation");
  });

  it("stores send and reply timestamps and reveals them on swipe", () => {
    expect(page).toContain("createdAt?: string");
    expect(page).toContain("createdAt: new Date().toISOString()");
    expect(page).toContain("onTouchStart");
    expect(page).toContain("onTouchMove");
    expect(page).toContain("onTouchEnd");
    expect(page).toContain("messageTime(message.createdAt)");
  });

  it("keeps Sarah's header to the name only without Gemini branding or a description", () => {
    expect(page).toContain('<span className="font-bold text-lg">سارة</span>');
    expect(page).not.toContain("مساعد نقطة الشحن — Gemini");
  });
});
