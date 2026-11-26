import { describe, expect, it } from "vitest";
import { buildSarahHistorySnapshot } from "../application/ai/sarahHistory";

describe("Sarah history bounds", () => {
  it("keeps only the latest 20 messages and caps each message at 6000 characters", () => {
    const input = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 ? "assistant" as const : "user" as const,
      text: `message-${index}-${"م".repeat(7000)}`,
    }));
    const result = buildSarahHistorySnapshot(input);
    expect(result).toHaveLength(20);
    expect(result[0].text).toContain("message-10-");
    expect(result.at(-1)?.text).toContain("message-29-");
    expect(result.every((message) => message.text.length <= 6000)).toBe(true);
  });

  it("caps total history at 12000 characters without reordering messages", () => {
    const input = [
      { role: "user" as const, text: "أ".repeat(6000) },
      { role: "assistant" as const, text: "ب".repeat(6000) },
      { role: "user" as const, text: "ج".repeat(6000) },
    ];
    const result = buildSarahHistorySnapshot(input);
    expect(result.reduce((total, message) => total + message.text.length, 0)).toBe(12000);
    expect(result.map((message) => message.role)).toEqual(["assistant", "user"]);
    expect(result[0].text).toBe("ب".repeat(6000));
    expect(result[1].text).toBe("ج".repeat(6000));
  });
});
