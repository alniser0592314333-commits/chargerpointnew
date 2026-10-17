import { assertEquals } from "jsr:@std/assert@1";
import { readBoundedRequestBody } from "./requestBodyLimit.ts";

Deno.test("accepts a streamed body at or below the hard limit", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const request = new Request("https://example.test/upload", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2));
        controller.close();
      },
    }),
    // Intentionally omit Content-Length: the stream itself is authoritative.
  });

  assertEquals(Array.from((await readBoundedRequestBody(request, 4)) ?? []), [1, 2, 3, 4]);
});

Deno.test("rejects an oversized streamed body even without Content-Length", async () => {
  let secondChunkRead = false;
  const request = new Request("https://example.test/upload", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!secondChunkRead) {
          secondChunkRead = true;
          controller.enqueue(new Uint8Array(3));
        } else {
          controller.enqueue(new Uint8Array(3));
        }
      },
    }),
  });

  assertEquals(await readBoundedRequestBody(request, 4), null);
});

Deno.test("rejects an oversized body when Content-Length lies about the actual size", async () => {
  let pulls = 0;
  const request = new Request("https://example.test/upload", {
    method: "POST",
    headers: { "content-length": "1" },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(3));
      },
    }),
  });

  assertEquals(await readBoundedRequestBody(request, 4), null);
  assertEquals(pulls >= 2, true);
});

Deno.test("rejects invalid limits rather than silently disabling protection", async () => {
  const request = new Request("https://example.test/upload", { method: "POST" });
  let thrown = false;
  try {
    await readBoundedRequestBody(request, -1);
  } catch (error) {
    thrown = error instanceof RangeError;
  }
  assertEquals(thrown, true);
});
