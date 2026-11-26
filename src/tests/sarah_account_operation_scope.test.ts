import { describe, it, expect } from "vitest";
import { SarahAccountOperationScope } from "../application/ai/sarahAccountOperationScope";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Sarah account operation scope", () => {
  it("discards a pending response after switching accounts", async () => {
    const scope = new SarahAccountOperationScope("fahd");
    const operation = scope.begin("fahd");
    const pending = deferred<string>();
    const committed = pending.promise.then((value) => scope.isCurrent(operation) ? value : null);

    scope.switchTo("munther");
    pending.resolve("Fahd private conversation response");

    expect(await committed).toBeNull();
    expect(scope.isCurrentAccount("munther")).toBe(true);
    expect(scope.isCurrent(operation)).toBe(false);
  });

  it("prevents an ABA account switch from reviving an old operation", () => {
    const scope = new SarahAccountOperationScope("fahd");
    const oldOperation = scope.begin("fahd");

    scope.switchTo("munther");
    scope.switchTo("fahd");

    expect(scope.isCurrentAccount("fahd")).toBe(true);
    expect(scope.isCurrent(oldOperation)).toBe(false);
    expect(scope.begin("fahd")).toEqual({ accountId: "fahd", generation: 2 });
  });

  it("does not issue an operation token for an inactive account", () => {
    const scope = new SarahAccountOperationScope("fahd");
    expect(scope.begin("munther")).toBeNull();
  });

  it("invalidates pending work when the user signs out", () => {
    const scope = new SarahAccountOperationScope("fahd");
    const operation = scope.begin("fahd");
    scope.switchTo(null);
    expect(scope.isCurrent(operation)).toBe(false);
    expect(scope.isCurrentAccount("fahd")).toBe(false);
  });

  it("invalidates pending work when the Auth subject changes under the same admin row", () => {
    const scope = new SarahAccountOperationScope("admin-row-1:auth-user-a");
    const operation = scope.begin("admin-row-1:auth-user-a");
    scope.switchTo("admin-row-1:auth-user-b");
    expect(scope.isCurrent(operation)).toBe(false);
    expect(scope.isCurrentAccount("admin-row-1:auth-user-b")).toBe(true);
  });
});
