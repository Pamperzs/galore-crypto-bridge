# SellAuth ⇄ NowPayments Bridge

Tiny Node service that lets a **SellAuth shop** accept crypto through the
shop's own **NowPayments** account using SellAuth's *custom payment method
("Redirect to URL")*.

```
Buyer ──click "Pay with Crypto"──▶ SellAuth checkout (custom method)
                                        │ redirect with Invoice ID / amount / currency
                                        ▼
                                 Bridge  GET /start
                                        │  creates NowPayments invoice (API key)
                                        ▼
                                 NowPayments checkout page (buyer picks coin)
                                        │  payment confirmed on-chain
                                        ▼
                                 Bridge  POST /ipn  (webhook, HMAC-checked)
                                        │  process invoice  (SellAuth API key)
                                        ▼
                                 SellAuth ──▶ order delivered + receipt emailed
```

The bridge never holds funds or sees coins: money settles into **your own
NowPayments balance**, and the bridge only translates authenticated webhooks
into "mark this SellAuth invoice as paid".

## Endpoints

| Method | Path    | Purpose |
| ------ | ------- | ------- |
| GET    | `/`     | health check (`{"ok":true}`) |
| GET    | `/start`| receives buyer from SellAuth, creates NowPayments invoice, 302s to checkout |
| POST   | `/ipn`  | NowPayments Instant Payment Notification; verifies `x-nowpayments-sig` (HMAC-SHA512, key-sorted JSON) and, on `finished`, processes the SellAuth invoice with `mark_as_paid=true` |

## Environment variables

| Variable | Required | Purpose |
| -------- | -------- | ------- |
| `NOWPAYMENTS_API_KEY` | yes | server-side NowPayments API key |
| `NOWPAYMENTS_IPN_SECRET` | yes | IPN secret from NowPayments store settings |
| `SELLAUTH_API_KEY` | yes | SellAuth API key (Account → Developers) |
| `SELLAUTH_SHOP_ID` | yes | numeric SellAuth shop id |
| `SELLAUTH_STORE_URL` | optional | e.g. `https://galorelb.com`; adds `success_url`/`cancel_url` back to the invoice page |
| `SELLAUTH_API_BASE` | optional | override, default `https://api.sellauth.com` |
| `PORT` | optional | default `10000` |

## Local run & tests

```bash
npm install          # no dependencies yet, keeps Render happy
npm start            # needs env vars; listens on $PORT (default 10000)
npm test             # 11 unit tests, no network required
```

## Deploy to Render

The service is a plain Node web service (repo root):

- Runtime: `node`, region `frankfurt` (matches the existing services),
- Build: `npm install`, Start: `npm start`,
- Add the five env vars above in the Render dashboard (or via API),
- Then point the SellAuth custom method's **Redirect URL** at:

```
https://<service>.onrender.com/start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}
```

> Free Render instances sleep when idle. The first request after sleep takes
> ~30–60s. NowPayments retries failed IPNs, so nothing is lost, but a paid
> instance (`0.5c-512mb`) removes the delay entirely.

## Security model

- The bridge verifies every IPN with HMAC-SHA512 over the key-sorted JSON body
  (`x-nowpayments-sig`), using the IPN secret. Rejected requests are never
  processed.
- Only `payment_status === "finished"` (funds settled to your NowPayments
  balance) unlocks an order.
- Orders are processed idempotently: a duplicate/late IPN after completion is
  acknowledged, not re-delivered.
- Never expose `NOWPAYMENTS_API_KEY` / `SELLAUTH_API_KEY` to a browser; they
  live only in Render's env vars.

## Troubleshooting

- `401 Invalid signature` in NowPayments IPN logs → IPN secret mismatch; copy
  the current secret from the dashboard into the Render env var.
- Buyer sees "Payment provider error" → check NowPayments invoice creation
  logs (invalid API key, unsupported price currency, amount below minimum).
- Order paid but not delivered → check Render logs around the IPN; the SellAuth
  invoice id comes from `order_id` (numeric).

## Notes

- `render.yaml` is a Blueprint definition with `sync: false` secrets; it does
  not contain any credentials.
- Replace/rotate the NowPayments API key or IPN secret at any time, then update
  the Render env vars.
