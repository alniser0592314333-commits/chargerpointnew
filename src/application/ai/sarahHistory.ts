export type SarahHistoryMessage = { role: "user" | "assistant"; text: string };

export const buildSarahHistorySnapshot = (
  messages: SarahHistoryMessage[],
  maxMessages = 20,
  maxPerMessageChars = 6000,
  maxTotalChars = 12000,
): SarahHistoryMessage[] => {
  const selected: SarahHistoryMessage[] = [];
  let remaining = maxTotalChars;

  for (const message of messages.slice(-maxMessages).reverse()) {
    if (remaining <= 0) break;
    const text = message.text.slice(-Math.min(maxPerMessageChars, remaining));
    if (!text) continue;
    selected.push({ role: message.role, text });
    remaining -= text.length;
  }

  return selected.reverse();
};
