import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import worker from "../src/worker.js";

const ENV = {
  NOWPAYMENTS_API_KEY: "np-key",
  NOWPAYMENTS_IPN_SECRET: "ipn-secret",
  SELLAUTH_API_KEY: "sa-key",
  SELLAUTH_SHOP_ID: "183061",
};

const origFetch = globalThis.fetch;

/* Independent reference of NowPayments' signing rule:
 * HMAC-SHA512 over JSON with keys sorted deep, hex digest. */
function deepSort(value) {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = deepSort(value[key]);
    return out;
  }
  return value;
}
function sign(payload, secret) {
  const body = JSON.stringify(deepSort(payload));
  return crypto.createHmac("sha512", secret).update(body).digest("hex");
}

function stubFetch(map) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    for (const [pattern, handler] of map) {
      if (url.includes(pattern)) return handler(url, init);
    }
    throw new Error("unexpected fetch: " + url);
  };
  return calls;
}

function ipnRequest(payload, signatureOverride) {
  const raw = JSON.stringify(payload);
  const sig = signatureOverride ?? sign(payload, ENV.NOWPAYMENTS_IPN_SECRET);
  return new Request("https://bridge.example/ipn", {
    method: "POST",
    headers: { "content-type": "application/json", "x-nowpayments-sig": sig },
    body: raw,
  });
}

const FINISHED_PAYLOAD = {
  payment_id: "5678901234",
  payment_status: "finished",
  order_id: "42",
  price_amount: 12.5,
  price_currency: "USD",
  pay_amount: 0.00025,
  pay_currency: "btc",
  actually_paid: 0.00025,
};

test("health endpoint answers", async () => {
  const res = await worker.fetch(new Request("https://bridge.example/"), ENV);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test("/start creates NowPayments invoice and redirects the buyer", async () => {
  const calls = stubFetch([
    [
      "api.nowpayments.io/v1/invoice",
      () =>
        new Response(
          JSON.stringify({ id: "inv1", invoice_url: "https://nowpayments.io/payment/?iid=inv1" }),
          { status: 200 }
        ),
    ],
  ]);
  try {
    const url =
      "https://bridge.example/start?invoice=42&ref=abc-0000017&amount=12.5&currency=USD&email=buyer@example.com";
    const res = await worker.fetch(new Request(url), ENV);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://nowpayments.io/payment/?iid=inv1");

    assert.equal(calls.length, 1);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(calls[0].init.headers["x-api-key"], "np-key");
    assert.equal(sent.price_amount, 12.5);
    assert.equal(sent.price_currency, "usd");
    assert.equal(sent.order_id, "42");
    assert.equal(sent.ipn_callback_url, "https://bridge.example/ipn");
    assert.equal(sent.customer_email, "buyer@example.com");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("/start rejects missing invoice id", async () => {
  const res = await worker.fetch(
    new Request("https://bridge.example/start?amount=5&currency=USD"),
    ENV
  );
  assert.equal(res.status, 400);
});

test("/start rejects invalid amount", async () => {
  const res = await worker.fetch(
    new Request("https://bridge.example/start?invoice=42&amount=abc&currency=USD"),
    ENV
  );
  assert.equal(res.status, 400);
});

test("/start surfaces NowPayments failure as 502", async () => {
  stubFetch([
    ["api.nowpayments.io/v1/invoice", () => new Response('{"message":"bad"}', { status: 500 })],
  ]);
  try {
    const res = await worker.fetch(
      new Request("https://bridge.example/start?invoice=42&amount=5&currency=USD"),
      ENV
    );
    assert.equal(res.status, 502);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("/ipn rejects requests with no signature", async () => {
  const raw = JSON.stringify(FINISHED_PAYLOAD);
  const req = new Request("https://bridge.example/ipn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
  const res = await worker.fetch(req, ENV);
  assert.equal(res.status, 401);
});

test("/ipn rejects a tampered/wrong signature", async () => {
  const res = await worker.fetch(ipnRequest(FINISHED_PAYLOAD, "00".repeat(64)), ENV);
  assert.equal(res.status, 401);
});

test("/ipn accepts valid signature but ignores non-finished status", async () => {
  const calls = stubFetch([
    [
      "api.sellauth.com",
      () => new Response('{"success":true}', { status: 200 }),
    ],
  ]);
  try {
    const waiting = { ...FINISHED_PAYLOAD, payment_status: "waiting" };
    const res = await worker.fetch(ipnRequest(waiting), ENV);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 0, "SellAuth must not be called before payment finished");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("/ipn finished payment processes the SellAuth invoice as paid (GET)", async () => {
  const calls = stubFetch([
    [
      "api.sellauth.com",
      (url) => {
        if (url.includes("/process")) {
          return new Response('{"success":"Invoice processed"}', { status: 200 });
        }
        if (url.includes("/invoices/")) {
          return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
        }
        throw new Error("unexpected sellauth url: " + url);
      },
    ],
  ]);
  try {
    const res = await worker.fetch(ipnRequest(FINISHED_PAYLOAD), ENV);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 2, "pre-check GET + process GET");
    assert.equal(
      calls[0].url,
      "https://api.sellauth.com/v1/shops/183061/invoices/42"
    );
    assert.equal(
      calls[1].url,
      "https://api.sellauth.com/v1/shops/183061/invoices/42/process?mark_as_paid=true"
    );
    assert.equal(calls[1].init.method, "GET", "process must be a GET request");
    assert.equal(calls[1].init.headers.Authorization, "Bearer sa-key");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("/ipn skips processing when the invoice is already completed", async () => {
  const calls = stubFetch([
    [
      "api.sellauth.com",
      () => new Response(JSON.stringify({ status: "completed" }), { status: 200 }),
    ],
  ]);
  try {
    const res = await worker.fetch(ipnRequest(FINISHED_PAYLOAD), ENV);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].url.includes("/process"), "must not re-process");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("/ipn treats an already-completed invoice as success (idempotent)", async () => {
  stubFetch([
    [
      "api.sellauth.com",
      () => new Response('{"success":false,"error":"Invoice already processed"}', { status: 409 }),
    ],
  ]);
  try {
    const res = await worker.fetch(ipnRequest(FINISHED_PAYLOAD), ENV);
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("/ipn finished payment with unusable order_id is refused", async () => {
  const bad = { ...FINISHED_PAYLOAD, order_id: "abc" };
  const res = await worker.fetch(ipnRequest(bad), ENV);
  assert.equal(res.status, 400);
});
