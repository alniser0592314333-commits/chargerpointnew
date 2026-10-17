import { assertEquals } from "jsr:@std/assert@1";
import { isAllowedReceiptPath } from "./receiptPathValidation.ts";

Deno.test("allows valid order-scoped receipt paths", () => {
  assertEquals(
    isAllowedReceiptPath("orders/123e4567-e89b-12d3-a456-426614174000/receipt.webp"),
    true,
  );
});

Deno.test("allows valid customer-scoped receipt paths", () => {
  assertEquals(
    isAllowedReceiptPath("customers/123e4567-e89b-12d3-a456-426614174000/payment-receipt.jpg"),
    true,
  );
});

Deno.test("rejects paths that could escape the receipt namespace", () => {
  assertEquals(isAllowedReceiptPath("../orders/123e4567-e89b-12d3-a456-426614174000/a.jpg"), false);
  assertEquals(isAllowedReceiptPath("/orders/123e4567-e89b-12d3-a456-426614174000/a.jpg"), false);
  assertEquals(isAllowedReceiptPath("orders\\\\123e4567-e89b-12d3-a456-426614174000\\\\a.jpg"), false);
  assertEquals(isAllowedReceiptPath("orders/123e4567-e89b-12d3-a456-426614174000/a.svg"), false);
  assertEquals(isAllowedReceiptPath("orders/not-a-uuid/a.jpg"), false);
  assertEquals(isAllowedReceiptPath("customers/123e4567-e89b-12d3-a456-426614174000/../a.jpg"), false);
  assertEquals(isAllowedReceiptPath(""), false);
  assertEquals(isAllowedReceiptPath(null), false);
});
