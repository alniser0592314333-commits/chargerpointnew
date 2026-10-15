import { createClient } from "npm:@supabase/supabase-js@2.117.2";

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

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });

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

    const { data: orderRows, error: resolveError } = await supabase.rpc("public_resolve_order_qr", {
      p_public_token: token,
    });
    if (resolveError) {
      console.error("Public QR resolve failed", resolveError.message);
      return json(500, { error: "Could not verify the order QR. Please try again." });
    }
    const order = Array.isArray(orderRows) ? orderRows[0] : orderRows;
    if (!order?.order_id || !Number.isInteger(order?.order_number)) {
      return json(404, { error: "This order QR is invalid or has expired" });
    }

    // Per-order rate limiting and duplicate-pending checks are repeated atomically
    // by submit_qr_payment; this early check avoids needless storage uploads.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const [pendingCheck, recentCheck] = await Promise.all([
      supabase.from("qr_payment_submissions").select("id", { count: "exact", head: true })
        .eq("order_id", order.order_id).eq("status", "PENDING"),
      supabase.from("qr_payment_submissions").select("id", { count: "exact", head: true })
        .eq("order_id", order.order_id).gt("created_at", oneHourAgo),
    ]);
    if (pendingCheck.error || recentCheck.error) {
      console.error("Submission rate check failed", pendingCheck.error?.message, recentCheck.error?.message);
      return json(500, { error: "Could not verify whether a notification is already pending" });
    }
    if ((pendingCheck.count ?? 0) > 0) return json(409, { error: "A payment notification for this order is already awaiting review" });
    if ((recentCheck.count ?? 0) >= 3) return json(429, { error: "Too many submissions for this order. Please try again later." });

    uploadedPath = `${order.order_id}/${crypto.randomUUID()}.${image.extension}`;
    const { error: uploadError } = await supabase.storage
      .from("qr-payment-receipts")
      .upload(uploadedPath, bytes, {
        contentType: image.mime,
        cacheControl: "300",
        upsert: false,
      });
    if (uploadError) {
      console.error("Receipt upload failed", uploadError.message);
      return json(500, { error: "The receipt image could not be uploaded. Please try again." });
    }

    const { data: submission, error: submitError } = await supabase.rpc("submit_qr_payment", {
      p_public_token: token,
      p_payment_method: method,
      p_receipt_path: uploadedPath,
      p_note: note || null,
    });
    if (submitError || !submission?.success) {
      await supabase.storage.from("qr-payment-receipts").remove([uploadedPath]);
      uploadedPath = null;
      const message = submitError?.message ?? "Submission was not accepted";
      const isConflict = /already awaiting review|no recognized outstanding amount|Too many payment notifications/i.test(message);
      return json(isConflict ? 409 : 400, {
        error: isConflict
          ? "This order already has a pending notification or has no recognized amount due."
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
