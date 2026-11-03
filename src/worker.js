/**
 * SellAuth ⇄ NowPayments bridge (Cloudflare Worker / Node-compatible).
 *
 * Flow:
 *   1. Buyer picks the "Crypto" method on SellAuth checkout.
 *   2. SellAuth redirects to  GET /start?invoice=&ref=&amount=&currency=&email=
 *      → we create a NowPayments invoice for that exact amount and 302 the
 *        buyer to NowPayments' hosted checkout.
 *   3. NowPayments sends  POST /ipn  when the payment status changes.
 *      → we verify the HMAC-SHA512 signature (x-nowpayments-sig header),
 *        and once the status is "finished", we call SellAuth's
 *        POST /v1/shops/{shop}/invoices/{id}/process?mark_as_paid=true
 *        which delivers the order and emails the receipt.
 *
 * Secrets (set as Worker secrets / env):
 *   NOWPAYMENTS_API_KEY    – NowPayments API key (server-side one)
 *   NOWPAYMENTS_IPN_SECRET – IPN secret from NowPayments store settings
 *   SELLAUTH_API_KEY       – SellAuth API key (Account > Developers)
 *   SELLAUTH_SHOP_ID       – numeric shop id (default: 183061)
 *   SELLAUTH_STORE_URL     – optional, e.g. https://galorelb.com (adds
 *                            success_url back to the invoice page)
 *   SELLAUTH_API_BASE      – optional override (default https://api.sellauth.com)
 */

const NP_INVOICE_URL = "https://api.nowpayments.io/v1/invoice";
const DEFAULT_SELLAUTH_BASE = "https://api.sellauth.com";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function text(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...extra },
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Recursively sort object keys (NowPayments signs the key-sorted JSON). */
export function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortDeep(value[k]);
    return out;
  }
  return value;
}

/** HMAC-SHA512 hex using WebCrypto (works in Workers and modern Node). */
export async function hmacSha512Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function stripTrailingSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

/* ------------------------------------------------------------------ */
/* /start — buyer arrives from SellAuth checkout                       */
/* ------------------------------------------------------------------ */

async function handleStart(request, env) {
  const url = new URL(request.url);
  const invoiceId = url.searchParams.get("invoice");
  const ref = url.searchParams.get("ref") || "";
  const amountRaw = url.searchParams.get("amount");
  const currencyRaw = url.searchParams.get("currency") || "";
  const email = url.searchParams.get("email") || "";

  if (!invoiceId || !/^\d+$/.test(invoiceId)) {
    return text("Bad request: missing/invalid invoice.", 400);
  }
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) {
    return text("Bad request: missing/invalid amount.", 400);
  }
  const currency = currencyRaw.toUpperCase();
  if (!/^[A-Z]{2,5}$/.test(currency)) {
    return text("Bad request: missing/invalid currency.", 400);
  }
  if (!env.NOWPAYMENTS_API_KEY) {
    console.error("bridge: NOWPAYMENTS_API_KEY is not configured");
    return text("Bridge misconfigured.", 500);
  }

  const origin = new URL(request.url).origin;
  const npPayload = {
    price_amount: amount,
    price_currency: currency.toLowerCase(),
    order_id: String(invoiceId),
    order_description: `SellAuth invoice ${invoiceId}` + (ref ? ` (${ref})` : ""),
    ipn_callback_url: `${origin}/ipn`,
  };
  // Only pass a customer_email when it looks like one (NP rejects garbage).
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    npPayload.customer_email = email;
  }
  // Optional: send the buyer back to their invoice page after paying.
  const storeUrl = stripTrailingSlash(env.SELLAUTH_STORE_URL || "");
  if (storeUrl && ref) {
    const invoicePage = `${storeUrl}/invoice/${encodeURIComponent(ref)}`;
    npPayload.success_url = invoicePage;
    npPayload.cancel_url = invoicePage;
  }

  let npResp;
  try {
    npResp = await fetch(NP_INVOICE_URL, {
      method: "POST",
      headers: {
        "x-api-key": env.NOWPAYMENTS_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify(npPayload),
    });
  } catch (err) {
    console.error("bridge: nowpayments request failed", err);
    return text("Payment provider unreachable. Please try again.", 502);
  }

  const npBodyText = await npResp.text();
  if (!npResp.ok) {
    console.error(
      "bridge: nowpayments invoice error",
      npResp.status,
      npBodyText.slice(0, 500)
    );
    return text("Payment provider error. Please try again later.", 502);
  }

  let npData;
  try {
    npData = JSON.parse(npBodyText);
  } catch {
    return text("Payment provider returned invalid data.", 502);
  }
  if (!npData.invoice_url) {
    console.error("bridge: nowpayments response missing invoice_url", npBodyText.slice(0, 300));
    return text("Payment provider error. Please try again later.", 502);
  }

  console.log(
    `bridge: invoice ${invoiceId} -> nowpayments invoice ${npData.id} (${npData.invoice_url})`
  );
  return Response.redirect(npData.invoice_url, 302);
}

/* ------------------------------------------------------------------ */
/* /ipn — NowPayments calls us when payment status changes             */
/* ------------------------------------------------------------------ */

async function handleIpn(request, env) {
  const raw = await request.text();
  const signature = request.headers.get("x-nowpayments-sig");

  if (!signature) return text("Missing signature.", 401);
  if (!env.NOWPAYMENTS_IPN_SECRET) {
    console.error("bridge: NOWPAYMENTS_IPN_SECRET is not configured");
    return text("Bridge misconfigured.", 500);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return text("Invalid payload.", 400);
  }
  if (!payload || typeof payload !== "object") return text("Invalid payload.", 400);

  const expected = await hmacSha512Hex(
    env.NOWPAYMENTS_IPN_SECRET.trim(),
    JSON.stringify(sortDeep(payload))
  );
  if (expected !== String(signature).trim().toLowerCase()) {
    console.warn("bridge: IPN signature mismatch — rejected");
    return text("Invalid signature.", 401);
  }

  const status = String(payload.payment_status || "");
  const orderId = String(payload.order_id || "");
  const paymentId = String(payload.payment_id || "");

  console.log(`bridge: IPN payment=${paymentId} order=${orderId} status=${status}`);

  // Only a finished payment (money settled to your NowPayments balance)
  // unlocks the order. Everything else is acknowledged and ignored.
  if (status !== "finished") {
    return text("OK (ignored)");
  }
  if (!/^\d+$/.test(orderId)) {
    console.error("bridge: IPN finished payment without usable order_id", payload);
    return text("Bad order_id.", 400);
  }
  if (!env.SELLAUTH_SHOP_ID) {
    console.error("bridge: SELLAUTH_SHOP_ID is not configured");
    return text("Bridge misconfigured.", 500);
  }

  const shopId = env.SELLAUTH_SHOP_ID;
  const base = stripTrailingSlash(env.SELLAUTH_API_BASE || DEFAULT_SELLAUTH_BASE);
  const processUrl = `${base}/v1/shops/${shopId}/invoices/${orderId}/process?mark_as_paid=true`;

  let saResp;
  try {
    saResp = await fetch(processUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.SELLAUTH_API_KEY}` },
    });
  } catch (err) {
    console.error("bridge: sellAuth process request failed", err);
    return text("SellAuth unreachable.", 500);
  }

  const saBody = await saResp.text();
  if (saResp.ok) {
    console.log(`bridge: invoice ${orderId} processed and marked paid`);
    return text("OK");
  }

  // If the invoice was already completed (duplicate IPN, double payment),
  // SellAuth refuses — that's fine, acknowledge so NP stops retrying.
  if (saResp.status === 409 || /already|complet/i.test(saBody) || saResp.status === 422) {
    console.warn(
      `bridge: invoice ${orderId} already handled (HTTP ${saResp.status})`,
      saBody.slice(0, 300)
    );
    return text("OK (already handled)");
  }

  console.error(
    `bridge: sellAuth process failed HTTP ${saResp.status}`,
    saBody.slice(0, 500)
  );
  return text("SellAuth error.", 500);
}

/* ------------------------------------------------------------------ */
/* router                                                              */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (request.method === "GET" && path === "/") {
        return json({ ok: true, service: "sellauth-nowpayments-bridge" });
      }
      if (request.method === "GET" && path === "/start") {
        return await handleStart(request, env);
      }
      if (request.method === "POST" && path === "/ipn") {
        return await handleIpn(request, env);
      }
      return text("Not found.", 404);
    } catch (err) {
      console.error("bridge: unhandled error", err);
      return text("Internal error.", 500);
    }
  },
};
