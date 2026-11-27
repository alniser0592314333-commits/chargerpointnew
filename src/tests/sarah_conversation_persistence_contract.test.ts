import { readFileSync } from "node:fs"; import { describe,it,expect } from "vitest";
const store=readFileSync("src/application/ai/sarahConversationStore.ts","utf8"), page=readFileSync("src/components/pages/SarahChatPage.tsx","utf8");
describe("Sarah conversation persistence",()=>{it("uses account keyed durable IndexedDB store and validates account",()=>{expect(store).toContain('keyPath:"accountId"');expect(store).toContain("ACCOUNT_REQUIRED");expect(store).toContain("indexedDB");});it("bounds retained conversation and persists transcript",()=>{expect(store).toContain("messages.length>500");expect(store).toContain("updatedAt");});it("hydrates and saves only the active account transcript",()=>{expect(page).toContain("sarahConversationStore.load(accountId)");expect(page).toContain("hydratedAccount !== accountId");expect(page).toContain("sarahConversationStore.save(accountId, messages, conversationGenerationRef.current)");expect(page).toContain("isCurrent(accountId, operation)");});

it("persists the full answer before marking either queue item complete",()=>{
  const sendIndex=page.indexOf("sendWithLocalActions(clean");
  const sendSave=page.indexOf("await sarahConversationStore.save(accountId, completedMessages", sendIndex);
  const sendComplete=page.indexOf('await sarahInputQueue.transition(accountId, id, "COMPLETED")', sendIndex);
  const retryIndex=page.indexOf("sendWithLocalActions(record.text");
  const retrySave=page.indexOf("await sarahConversationStore.save(accountId, completedMessages", retryIndex);
  const retryComplete=page.indexOf('await sarahInputQueue.transition(accountId, record.id, "COMPLETED")', retryIndex);
  expect(sendIndex).toBeGreaterThan(-1);
  expect(sendSave).toBeGreaterThan(sendIndex);
  expect(retryIndex).toBeGreaterThan(-1);
  expect(sendComplete).toBeGreaterThan(sendSave);
  expect(retrySave).toBeGreaterThan(-1);
  expect(retryComplete).toBeGreaterThan(retrySave);
});

it("clears only the current hydrated account transcript",()=>{expect(page).toContain("sarahConversationStore.clear(accountId)");expect(page).toContain("hydratedAccount !== accountId");expect(page).toContain("isCurrent(accountId, operation)");expect(page).toContain("conversationGenerationRef.current = nextGeneration");expect(page).toContain("مسح سجل المحادثة");});

it("persists clear tombstones to prevent stale transcript resurrection",()=>{expect(store).toContain('const META = "meta"');expect(store).toContain("clearedAt");expect(store).toContain("transaction([STORE,META]");expect(store).toContain("current!==generation");expect(store).toContain("nextGeneration=current+1");expect(page).toContain("conversationGenerationRef.current = snapshot.generation");});});

describe("Sarah transcript cross-tab clear contract",()=>{it("broadcasts clear generations and synchronizes only the matching account",()=>{expect(store).toContain('new BroadcastChannel("sarah-conversation-clear")');expect(store).toContain("channel?.postMessage({accountId,generation:nextGeneration})");expect(page).toContain("subscribeToClear");expect(page).toContain("notice.accountId !== accountId");expect(page).toContain("snapshot.generation >= conversationGenerationRef.current");});});
