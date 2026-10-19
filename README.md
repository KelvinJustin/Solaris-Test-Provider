# Solaris Payment Simulator

A self-hosted test payment provider that simulates Airtel Money and TNM Mpamba. It accepts payment initiation requests, resolves them to a configurable outcome, and delivers signed webhook callbacks to your server — without touching any real payment network.

---

## Getting Started

### Prerequisites

- Node.js 20+
- npm

### Install

```bash
npm install
```

### Run

```bash
cp .env.example .env
node index.js
```

The server starts on port `8080` by default.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `8080` | Port the simulator listens on |
| `SOLARIS_CALLBACK_URL` | Yes | — | URL the simulator POSTs callbacks to |
| `SIGNING_SECRET` | Yes (prod) | `local-development-secret` | Secret used to sign callback payloads. Must be ≥ 32 chars in production |
| `DEV_API_KEY` | Yes (prod) | — | API key for `/dev/*` routes. Must be ≥ 32 chars in production |
| `CALLBACK_DELAY_MS` | No | `2000` | Base delay before a callback is sent |
| `MAX_CALLBACK_ATTEMPTS` | No | `3` | How many times to retry a failed callback delivery |
| `CALLBACK_TIMEOUT_MS` | No | `5000` | Per-attempt HTTP timeout for callback delivery |
| `CALLBACK_MODE` | No | `normal` | `normal` \| `none` \| `duplicate` — see Callback Modes |
| `SIMULATE_LATENCY` | No | `false` | Adds random jitter (up to 1s) before each callback |
| `NODE_ENV` | No | — | Set to `production` to enforce secret requirements |

---

## Callback Verification

Every callback is signed. Verify it in your webhook handler:

```js
const crypto = require("node:crypto");

function isValidCallback(req) {
  const timestamp = req.headers["x-provider-timestamp"];
  const signature = req.headers["x-provider-signature"];
  const rawBody = req.rawBody; // requires express raw body capture

  const expected = crypto
    .createHmac("sha256", process.env.SIGNING_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature || "");

  return (
    expectedBuf.length === actualBuf.length &&
    crypto.timingSafeEqual(expectedBuf, actualBuf)
  );
}
```

---

## Callback Payload

```json
{
  "event": "payment.updated",
  "providerReference": "uuid",
  "transactionReference": "your-reference",
  "amount": 1500.00,
  "currency": "MWK",
  "provider": "AIRTEL_MONEY",
  "status": "SUCCESSFUL",
  "occurredAt": "2025-01-01T10:00:00.000Z"
}
```

Failed payments also include:

```json
{
  "failureCode": "INSUFFICIENT_FUNDS",
  "failureMessage": "Customer has insufficient funds."
}
```

---

## Callback Modes

| Mode | Behaviour |
|---|---|
| `normal` | One callback per transaction |
| `none` | No callbacks sent — test polling/verification only |
| `duplicate` | Sends 2+ callbacks — test idempotency on your webhook handler |

---

## Test Phone Numbers

Control outcomes by using a specific phone number. The simulator resolves the scenario at initiation time; the verification endpoint always reflects the final outcome regardless of callback delivery.

### Airtel Money

| Phone | Scenario |
|---|---|
| `990000000` | Successful payment |
| `990000001` | Failed — `INSUFFICIENT_FUNDS` |
| `990000002` | Silent — no callback ever arrives |
| `990000003` | Successful — delayed callback (5× base delay) |
| `990000004` | Successful — 3 duplicate callbacks |
| `990000005` | Failed — `PROVIDER_TIMEOUT` |
| `990000006` | Contradictory callback — sends `FAILED` before the real `SUCCESSFUL` |
| `990000007` | Malformed callback — missing and invalid fields |
| `990000008` | Successful — first delivery attempt returns 503, then retries succeed |
| `990000009` | Successful — initiation response delayed 15s (tests ambiguous initiation) |
| `990000010` | Successful — verification returns 503 twice before succeeding |

### TNM Mpamba

| Phone | Scenario |
|---|---|
| `899817565` | Successful payment |
| `899817566` | Failed — `INVALID_ACCOUNT` |
| `899817567` | Silent — no callback ever arrives |
| `899817568` | Successful — delayed callback |
| `899817569` | Successful — 3 duplicate callbacks |
| `899817570` | Failed — `DAILY_LIMIT_EXCEEDED` |
| `899817571` | Contradictory callback |
| `899817572` | Malformed callback |
| `899817573` | Successful — 503 on first delivery attempt |
| `899817574` | Successful — initiation response delayed 15s |
| `899817575` | Successful — verification returns 503 twice |

Any number not in the list above resolves to `FAILED` with `UNKNOWN_NUMBER`.

---

## API Reference

### Public

#### `GET /health`

Returns server status and active configuration. No authentication required.

#### `POST /initiate`

Initiates a simulated payment.

**Request body:**

```json
{
  "transactionReference": "your-unique-ref",
  "amount": 1500.00,
  "phoneNumber": "0990000000",
  "provider": "AIRTEL_MONEY",
  "currency": "MWK"
}
```

- `transactionReference` — must be unique per simulator session
- `amount` — positive number, at most two decimal places
- `provider` — `AIRTEL_MONEY` or `TN_MPAMBA`
- `currency` — must be `MWK`

**Response `202`:**

```json
{
  "providerReference": "uuid",
  "transactionReference": "your-unique-ref",
  "status": "PROCESSING",
  "message": "Payment accepted for simulation."
}
```

#### `GET /transactions/:providerReference`

Returns the current state of a transaction. Use this when a callback has not arrived or you need to confirm the result independently.

Returns `503` a configurable number of times for numbers ending in `010` / `575` before resolving — simulates transient verification failures.

---

### Development (`/dev/*`)

All `/dev` routes require the `X-Dev-Key` header matching `DEV_API_KEY`. When `DEV_API_KEY` is not set, all `/dev` routes return `503`.

#### `GET /dev/scenarios`

Lists all test phone numbers and their configured scenarios.

#### `GET /dev/transactions`

Lists all transactions created since the last reset.

#### `GET /dev/callbacks`

Lists every callback delivery attempt, including payload, HTTP status, and any errors.

#### `POST /dev/callback/fire`

Manually triggers a callback for any existing transaction. Useful when `CALLBACK_MODE=none` or when testing specific outcomes without using a test number.

**Request body:**

```json
{
  "providerReference": "uuid",
  "status": "SUCCESSFUL"
}
```

#### `POST /dev/reset`

Clears all transactions and callback logs. Call this between test runs to ensure isolation.

---

## Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8080
CMD ["node", "index.js"]
```

### Docker Compose

```yaml
services:
  app:
    build: .
    environment:
      SOLARIS_CALLBACK_URL: http://simulator:8080/webhooks/payments

  simulator:
    build: ./simulator
    environment:
      SOLARIS_CALLBACK_URL: http://app:3000/webhooks/payments
      SIGNING_SECRET: local-dev-secret-change-in-production
      DEV_API_KEY: local-dev-key-change-in-production
    ports:
      - "8080:8080"
```

Point your app at `http://simulator:8080` instead of the real provider URL. Swap the env var for production — no code changes needed.

---

## Testing Patterns

**Isolate test runs** — call `POST /dev/reset` in your `beforeEach` or `afterEach`.

**Test idempotency** — use phone numbers `990000004` / `899817569` to send duplicate callbacks and confirm your webhook handler processes the payment exactly once.

**Test polling** — set `CALLBACK_MODE=none` and drive outcomes via `POST /dev/callback/fire` or poll `GET /transactions/:providerReference` directly.

**Test ambiguous initiations** — use phone numbers `990000009` / `899817574` to simulate a client timeout during initiation, then verify via the polling endpoint.

**Assert callback delivery** — after a transaction settles, `GET /dev/callbacks` and assert the expected number of deliveries with `success: true`.

**Verify signatures in CI** — because the simulator always signs callbacks, your HMAC verification runs on every test, not just against the real provider.