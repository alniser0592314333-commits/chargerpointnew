import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.117.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const allowedMethods = new Set(["JAWAL_PAY", "PALPAY", "BANK_OF_PALESTINE"]);

function inspectImage(bytes: Uint8Array): { mime: string; extension: string } | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
      bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { mime: "image/png", extension: "png" };
  }
  if (bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    return { mime: "image/webp", extension: "webp" };
  }
  return null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function uploadVerifiedReceipt(
  supabase: SupabaseClient<any, "public", any>,
  targetKind: "ORDER" | "CUSTOMER",
  targetId: string,
  bytes: Uint8Array,
  image: { mime: string; extension: string },
): Promise<string | null> {
  const storage = supabase.storage.from("qr-payment-receipts");

  // A successful Storage upload response is not enough: production logs showed that
  // the metadata row existed while the backing object returned NoSuchKey on signing.
  // Read the object back and compare its digest before creating a database reference.
  for (let uploadAttempt = 0; uploadAttempt < 2; uploadAttempt += 1) {
    const path = `${targetKind === "ORDER" ? "orders" : "customers"}/${targetId}/${crypto.randomUUID()}.${image.extension}`;
    const { error: uploadError } = await storage.upload(path, bytes, {
      contentType: image.mime,
      cacheControl: "300",
      upsert: false,
    });

    if (uploadError) {
      console.error("Receipt upload attempt failed", uploadAttempt + 1, uploadError.message);
      if (uploadAttempt === 0) await sleep(300);
      continue;
    }

    let verified = false;
    let lastReadError = "";
    for (let readAttempt = 0; readAttempt < 2; readAttempt += 1) {
      // Verify the same signing operation used by the admin review screen, then
      // download and hash the bytes. A metadata row or upload 200 alone is insufficient.
      const { data: signedReceipt, error: signError } = await storage.createSignedUrl(path, 300);
      if (signError || !signedReceipt?.signedUrl) {
        lastReadError = signError?.message ?? "Storage did not return a signed receipt URL";
      } else {
        const { data: downloaded, error: readError } = await storage.download(path);
        if (!readError && downloaded && downloaded.size === bytes.length) {
          try {
            const downloadedBytes = new Uint8Array(await downloaded.arrayBuffer());
            // Use fresh ArrayBuffers because Deno's WebCrypto type rejects ArrayBufferLike
            // views that may be backed by SharedArrayBuffer.
            const sourceBuffer = bytes.slice().buffer as ArrayBuffer;
            const downloadedBuffer = downloadedBytes.slice().buffer as ArrayBuffer;
            const [sourceDigest, downloadedDigest] = await Promise.all([
              crypto.subtle.digest("SHA-256", sourceBuffer),
              crypto.subtle.digest("SHA-256", downloadedBuffer),
            ]);
            const sourceHash = Array.from(new Uint8Array(sourceDigest)).join(",");
            const downloadedHash = Array.from(new Uint8Array(downloadedDigest)).join(",");
            if (sourceHash === downloadedHash) {
              verified = true;
              break;
            }
            lastReadError = "SHA-256 mismatch after receipt upload";
          } catch (verifyError) {
            lastReadError = verifyError instanceof Error ? verifyError.message : String(verifyError);
          }
        } else {
          lastReadError = readError?.message ?? `read-back size mismatch (${downloaded?.size ?? "missing"} vs ${bytes.length})`;
        }
      }
      if (readAttempt === 0) await sleep(300);
    }

    if (verified) return path;

    console.error("Receipt upload read-back verification failed", {
      attempt: uploadAttempt + 1,
      path,
      error: lastReadError,
    });
    const { error: cleanupError } = await storage.remove([path]);
    if (cleanupError) console.warn("Could not clean up unverified receipt object", cleanupError.message);
    if (uploadAttempt === 0) await sleep(500);
  }

  return null;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 3 * 1024 * 1024) {
    return json(413, { error: "The upload is too large. Please choose a smaller receipt image." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json(500, { error: "Server is not configured" });

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let uploadedPath: string | null = null;
  try {
    const form = await request.formData();
    const token = String(form.get("token") ?? "").trim();
    const method = String(form.get("payment_method") ?? "").trim().toUpperCase();
    const note = String(form.get("note") ?? "").trim().slice(0, 500);
    const receipt = form.get("receipt");

    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return json(400, { error: "QR token is invalid" });
    if (!allowedMethods.has(method)) return json(400, { error: "Choose a valid payment method" });
    if (!(receipt instanceof File)) return json(400, { error: "A receipt image is required" });
    if (receipt.size < 16 || receipt.size > 2 * 1024 * 1024) {
      return json(400, { error: "Receipt image must be smaller than 2 MB" });
    }

    const bytes = new Uint8Array(await receipt.arrayBuffer());
    const image = inspectImage(bytes);
    if (!image) return json(400, { error: "The uploaded file is not a supported JPEG, PNG, or WebP image" });

    const { data: orderRows, error: orderResolveError } = await supabase.rpc("public_resolve_order_qr", {
      p_public_token: token,
    });
    if (orderResolveError) {
      console.error("Public order QR resolve failed", orderResolveError.message);
      return json(500, { error: "Could not verify the QR. Please try again." });
    }
    const resolvedOrder = Array.isArray(orderRows) ? orderRows[0] : orderRows;
    let orderId: string | null = null;
    let customerId: string;
    let targetId: string;
    let targetKind: "ORDER" | "CUSTOMER";
    let amountMinor: number;

    if (resolvedOrder?.order_id && Number.isInteger(Number(resolvedOrder?.order_number))) {
      orderId = String(resolvedOrder.order_id);
      targetId = orderId;
      targetKind = "ORDER";
      if (typeof resolvedOrder.customer_has_positive_credit !== "boolean") {
        console.error("Order QR response did not include authoritative customer credit state");
        return json(503, { error: "Could not verify the account balance. Please refresh and try again." });
      }
      if (resolvedOrder.customer_has_positive_credit) {
        return json(400, { error: "Your account has positive credit. No order payment is needed right now." });
      }
      amountMinor = Number(resolvedOrder.order_due_minor);
      const { data: orderRecord, error: orderLookupError } = await supabase
        .from("orders").select("id,customer_id").eq("id", orderId).maybeSingle();
      if (orderLookupError || !orderRecord?.customer_id) {
        console.error("Order customer lookup failed", orderLookupError?.message);
        return json(404, { error: "This order QR is invalid or has expired" });
      }
      customerId = String(orderRecord.customer_id);
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > 99_999_999_999) {
        return json(400, { error: "No amount is due through this order QR. Payment is accepted only for financially recognized charges." });
      }
    } else {
      const { data: customerRows, error: customerResolveError } = await supabase.rpc("public_resolve_customer_qr", {
        p_public_token: token,
      });
      if (customerResolveError) {
        console.error("Public customer QR resolve failed", customerResolveError.message);
        return json(500, { error: "Could not verify the customer QR. Please try again." });
      }
      const resolvedCustomer = Array.isArray(customerRows) ? customerRows[0] : customerRows;
      const { data: tokenRecord, error: tokenLookupError } = await supabase
        .from("qr_tokens").select("target_id,expires_at")
        .eq("public_token", token).eq("token_type", "CUSTOMER").eq("is_active", true).maybeSingle();
      if (tokenLookupError || !resolvedCustomer || !tokenRecord?.target_id ||
          (tokenRecord.expires_at && new Date(tokenRecord.expires_at).getTime() <= Date.now())) {
        return json(404, { error: "This customer QR is invalid or has expired" });
      }
      const { data: customerRecord, error: customerLookupError } = await supabase
        .from("customers").select("id,is_active,status,deleted_at")
        .eq("id", tokenRecord.target_id).maybeSingle();
      if (customerLookupError || !customerRecord || customerRecord.is_active !== true ||
          customerRecord.deleted_at || String(customerRecord.status ?? "").toUpperCase() === "DELETED") {
        return json(404, { error: "This customer QR is invalid or has expired" });
      }
      customerId = String(customerRecord.id);
      targetId = customerId;
      targetKind = "CUSTOMER";
      // The receipt is only a review request. The authorized reviewer enters the verified amount at approval.
      amountMinor = 0;
    }

    // Customer-level notifications are keyed to the customer, not an order.
    // Database checks below repeat duplicate prevention and rate limiting atomically.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const pendingChecks = orderId
      ? [
          supabase.from("qr_payment_submissions").select("id", { count: "exact", head: true })
            .eq("status", "PENDING").eq("order_id", orderId),
          supabase.from("qr_payment_submissions").select("id", { count: "exact", head: true })
            .eq("status", "PENDING").eq("customer_id", customerId).is("order_id", null),
        ]
      : [
          supabase.from("qr_payment_submissions").select("id", { count: "exact", head: true })
            .eq("status", "PENDING").eq("customer_id", customerId),
        ];
    const recentQuery = orderId
      // Order QR lifetime cap: no more than three submissions for one order QR.
      ? supabase.from("qr_payment_submissions").select("id", { count: "exact", head: true })
          .eq("order_id", orderId)
      // Customer account QR remains usable over time but is rate-limited per hour.
      : supabase.from("qr_payment_submissions").select("id", { count: "exact", head: true })
          .eq("customer_id", customerId).gt("created_at", oneHourAgo);
    const [pendingResults, recentCheck] = await Promise.all([
      Promise.all(pendingChecks),
      recentQuery,
    ]);
    const pendingError = pendingResults.find((result) => result.error)?.error;
    if (pendingError || recentCheck.error) {
      console.error("Submission rate check failed", pendingError?.message, recentCheck.error?.message);
      return json(500, { error: "Could not verify whether a notification is already pending" });
    }
    if (pendingResults.some((result) => (result.count ?? 0) > 0)) {
      return json(409, { error: "A payment notification for this account or order is already awaiting review" });
    }
    if ((recentCheck.count ?? 0) >= 3) {
      return orderId
        ? json(409, { error: "Maximum of three payment notifications reached for this order QR." })
        : json(429, { error: "Too many submissions for this customer account. Please try again later." });
    }

    uploadedPath = await uploadVerifiedReceipt(supabase, targetKind, targetId, bytes, image);
    if (!uploadedPath) {
      return json(503, {
        error: "The receipt could not be verified in storage. No payment notification was saved; please try again.",
      });
    }

    const { data: submission, error: submitError } = await supabase.rpc("submit_qr_payment", {
      p_public_token: token,
      p_payment_method: method,
      p_receipt_path: uploadedPath,
      p_note: note || null,
      p_amount_minor: null,
    });
    if (submitError || !submission?.success) {
      await supabase.storage.from("qr-payment-receipts").remove([uploadedPath]);
      uploadedPath = null;
      const message = submitError?.message ?? "Submission was not accepted";
      const isMaximumSubmissions = /maximum of three payment notifications/i.test(message);
      const isCreditBlocked = /positive credit/i.test(message);
      const isNoAmountDue = /no remaining amount|no amount due/i.test(message);
      const isConflict = /already awaiting review|Too many payment notifications|too many submissions/i.test(message);
      return json(isMaximumSubmissions || isNoAmountDue || isConflict ? 409 : 400, {
        error: isMaximumSubmissions
          ? "Maximum of three payment notifications reached for this order QR."
          : isCreditBlocked
            ? "Your account has positive credit. No order payment is needed right now."
            : isNoAmountDue
              ? "No amount is due through this order QR. Payment is accepted only for financially recognized charges."
              : isConflict
                ? "This account or order already has a pending notification."
                : "The payment notification could not be saved. Please try again.",
      });
    }

    uploadedPath = null; // The receipt is now referenced by the persisted submission.
    return json(200, {
      success: true,
      submission_id: submission.submission_id,
      amount_minor: submission.amount_minor,
      status: submission.status,
    });
  } catch (error) {
    console.error("QR payment submission failed", error);
    if (uploadedPath) {
      await supabase.storage.from("qr-payment-receipts").remove([uploadedPath]).catch(() => ({ data: null, error: null }));
    }
    return json(500, { error: "Something went wrong while sending the payment notification. Please try again." });
  }
});
