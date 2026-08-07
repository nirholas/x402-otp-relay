# Skill: x402-otp-relay

## What this service does

Half of the internet's signup flows end with "we've emailed you a code". An agent with no inbox stops there. This service rents you a **disposable relay mailbox**: you get an address to paste into the form, the site emails it, and you poll for the extracted code.

Inbound mail arrives over real SMTP — point an MX record at it and genuine verification email lands here. The extraction is the part that matters: a verification email is full of numbers (order ids, years, prices, phone numbers), and "first six digits wins" is wrong often enough to burn login attempts. Codes come back **ranked, with a confidence score, the method that found them, and the surrounding text**, so you can judge rather than guess.

**Payment: USDC on Base or Solana — your client picks the rail.** Every 402 lists both.

## Base URL

```
<BASE_URL>          # e.g. http://localhost:4035, or your deployment
```

## The flow

```
POST /mailbox ($0.01)  →  paste relayAddress into the signup form
                       →  site sends mail → SMTP → codes extracted
GET /messages/:token (free, poll)  →  messageCount > 0?
GET /codes/:token ($0.002)         →  the code
DELETE /mailbox/:token (free)      →  done, clean up
```

The free `/messages` poll exists so you don't pay $0.002 repeatedly while waiting. Poll it until `messageCount > 0`, then pay once.

## Endpoints

### POST /mailbox — $0.01

**Body** (optional)

| field | type | meaning |
|---|---|---|
| `label` | string | Your own bookkeeping label, echoed back |
| `ttlSeconds` | number | Requested lifetime. Minimum 60s, capped by the server's TTL (default 15 min) |

**Response 200**

```jsonc
{
  "mailbox": {
    "payload": {
      "relayAddress": "otp-9dc876f944af47e6978c@relay.example.com",
      "mailboxToken": "cSrQEfBpVBX1nH2k…",
      "expiry": "2026-08-07T16:15:00.000Z",
      "createdAt": "2026-08-07T16:00:00.000Z",
      "label": "signup-run-8812",
      "pollUrl": "/codes/cSrQEfBpVBX1nH2k…"
    },
    "signature": "…", "algorithm": "HMAC-SHA256"
  },
  "smtp": { "host": "relay.example.com", "port": 25 },
  "paidWith": { "rail": "evm", "network": "base-sepolia", "transaction": "0x…" }
}
```

**`relayAddress` is public; `mailboxToken` is the credential.** They are deliberately different: the address gets typed into someone else's form and ends up in their logs, so it must not be the thing that reads the mailbox. The address is a hash of the token, not the token.

### GET /codes/:token — $0.002

```jsonc
{
  "result": {
    "payload": {
      "mailboxToken": "cSrQEfBpVBX1nH2k…",
      "relayAddress": "otp-9dc876f944af47e6978c@relay.example.com",
      "expiry": "2026-08-07T16:15:00.000Z",
      "messageCount": 1,
      "codes": [
        {
          "code": "481920",
          "kind": "numeric",
          "confidence": 0.95,
          "method": "labelled",
          "source": "subject",
          "context": "481920 is your verification code"
        }
      ],
      "best": { "code": "481920", "confidence": 0.95, "…": "…" },
      "links": [],
      "messages": [
        { "id": "msg_…", "receivedAt": "…", "from": "noreply@bank.example",
          "subject": "481920 is your verification code", "codes": ["481920"] }
      ],
      "waitedMs": 4210,
      "polledAt": "2026-08-07T16:00:04.210Z"
    },
    "signature": "…", "algorithm": "HMAC-SHA256"
  }
}
```

**An empty `codes` array is a valid, paid-for answer.** It means the mailbox is live and the mail has not arrived yet — which is different from a bad token (that's a 404). Use `waitedMs` to decide whether to keep waiting.

### Reading the confidence score

| confidence | method | what it means |
|---|---|---|
| 0.95 | `labelled` | A label named it, in the subject line. Type this one. |
| 0.9 | `labelled` | A label named it in the body — "your verification code is X". |
| 0.8 | `magic-link` | A URL whose path says verify/confirm/login. **Following it is a different action from typing a code** — decide deliberately. |
| 0.75 | `isolated-line` | Stood alone on its own line. Very common layout, slightly less certain. |
| 0.7 | `subject` | A code-shaped token in the subject with no label. Weakest; check `context`. |

`kind` is `numeric`, `alphanumeric`, or `link`. `best` is the top-ranked **non-link** candidate, which is almost always what you want. `links` is kept separate for the same reason.

`context` is ~80 characters of the surrounding text. Read it when confidence is below 0.9 — it's usually immediately obvious whether the number is the code or an order reference.

### GET /messages/:token — free

```jsonc
{
  "messageCount": 1,
  "messages": [ { "id": "msg_…", "receivedAt": "…", "from": "noreply@bank.example",
                  "subject": "481920 is your verification code", "codesFound": 1 } ],
  "hint": "GET /codes/:token ($0.002) returns the extracted codes themselves."
}
```

Metadata only, no codes. **Poll this while waiting** — it's free — and pay for `/codes` once `messageCount > 0`.

### DELETE /mailbox/:token — free

`{ "released": true, "mailboxToken": "…" }`. Do this when you're finished. Mailboxes expire on their own, but leaving other people's verification codes sitting on a server is not a good habit.

### POST /verify — free

`{ payload, signature }` → `{ valid: true|false }`.

### GET /health — free

`{ ok, service, rails, smtp: { listening, port, domain }, mailboxes, messages, domain, ttlMs }`.

## Payment

- Protocol: **x402**, `scheme: "exact"`, `x402Version: 1`.
- Asset: **USDC** (6 decimals) on both rails.
- Rails in every 402 `accepts` array:
  - `network: "base-sepolia"` (or `base`), payTo `0x40252CFDF8B20Ed757D61ff157719F33Ec332402`, facilitator `https://x402.org/facilitator`.
  - `network: "solana"` (or `solana-devnet`), payTo `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`, facilitator `https://facilitator.payai.network`. `extra.feePayer` sponsors the SOL fee, so you need only USDC.
- Pay with `x402-fetch`, `@three-ws/x402-payment-modal`, or any x402 client.
- The 200 carries `X-PAYMENT-RESPONSE` (base64 JSON) with rail, network, transaction and payer.

## Budgeting

$0.01 to rent, $0.002 per poll. The naive loop — poll `/codes` every second for thirty seconds — costs $0.06 and mostly buys empty arrays. Instead:

```ts
const { mailbox } = await pay(`${BASE}/mailbox`, { method: "POST", … });  // $0.01
// …paste mailbox.payload.relayAddress into the form…

// Free polling until the mail lands.
for (let i = 0; i < 30; i++) {
  const { messageCount } = await fetch(`${BASE}/messages/${token}`).then(r => r.json());
  if (messageCount > 0) break;
  await new Promise(r => setTimeout(r, 1000));
}

const { result } = await pay(`${BASE}/codes/${token}`).then(r => r.json());  // $0.002, once
```

Total: $0.012 for a verification, regardless of how long the mail takes.

## Error codes

| status | body `error` | meaning |
|---|---|---|
| 402 | `X-PAYMENT header is required` | Unpaid. Read `accepts`, pay, retry. |
| 402 | `invalid X-PAYMENT header: …` / `unsupported rail: …` | Malformed payload, or a network this endpoint doesn't take. |
| 402 | `payment rejected: …` / `settlement failed: …` | Facilitator refused or couldn't settle. Not charged. |
| 400 | `BAD_REQUEST` | `/verify` without `payload` + `signature`. |
| 404 | `MAILBOX_NOT_FOUND` | Unknown or **expired** token. Mailboxes are short-lived — rent a new one. |
| 500 | `no_payment_rail` | Server misconfigured: no valid payTo on either rail. |
| 502 | `facilitator_unreachable` / `settlement_error` | Facilitator down. Retry; not charged. |

Note: an empty `codes` array is a **200**, not a 404. The 404 means your token is wrong or the mailbox expired.

## What this is not for

The service exists so an agent can complete a verification step **for an account it is legitimately setting up or operating**. Using a disposable relay to evade a service's identity requirements, create bulk fake accounts, or receive codes for an account that isn't yours is abuse, and in the last case likely a criminal one. The operator of a deployment sees every code that passes through it.

## Discovery

- Manifest: `<BASE_URL>/.well-known/x402`
- Docs: https://nirholas.github.io/x402-otp-relay/
- Source: https://github.com/nirholas/x402-otp-relay
- Contact: nichxbt@gmail.com
