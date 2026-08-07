# API reference — x402-otp-relay

Two surfaces: the **HTTP API** and the **library** (mailbox store, SMTP relay, and the extractor on its own).

- Machine-readable: [`openapi.json`](https://github.com/nirholas/x402-otp-relay/blob/main/openapi.json) · [`/.well-known/x402`](https://github.com/nirholas/x402-otp-relay/blob/main/public/.well-known/x402)
- Agent-facing summary: [`skill.md`](https://github.com/nirholas/x402-otp-relay/blob/main/skill.md)

---

## HTTP API

Base URL: `http://localhost:4035` in dev.

### `POST /mailbox` — $0.01

**Body** (optional)

| field | type | notes |
|---|---|---|
| `label` | string | Your own bookkeeping label, echoed back |
| `ttlSeconds` | number | Requested lifetime. Minimum 60s, capped by the server's TTL (default 900s) |

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

`relayAddress` is **public** — it's `otp-<sha256(token)[0:20]>@<domain>`. `mailboxToken` is the **credential**.

### `GET /codes/:token` — $0.002

```jsonc
{
  "result": {
    "payload": {
      "mailboxToken": "cSrQEfBpVBX1nH2k…",
      "relayAddress": "otp-9dc…@relay.example.com",
      "expiry": "2026-08-07T16:15:00.000Z",
      "messageCount": 1,
      "codes": [
        { "code": "481920", "kind": "numeric", "confidence": 0.95,
          "method": "labelled", "source": "subject",
          "context": "481920 is your verification code" }
      ],
      "best": { "code": "481920", "…": "…" },
      "links": [],
      "messages": [
        { "id": "msg_a1b2c3d4", "receivedAt": "…", "from": "noreply@bank.example",
          "subject": "481920 is your verification code", "codes": ["481920"] }
      ],
      "waitedMs": 4210,
      "polledAt": "2026-08-07T16:00:04.210Z"
    },
    "signature": "…", "algorithm": "HMAC-SHA256"
  },
  "paidWith": { … }
}
```

An empty `codes` array is a **200**, not an error: the mailbox is live and the mail hasn't arrived. A **404** means the token is wrong or the mailbox expired.

`codes` is de-duplicated across every message in the mailbox and sorted by confidence descending.

### `GET /messages/:token` — free

```jsonc
{
  "messageCount": 1,
  "messages": [ { "id": "msg_…", "receivedAt": "…", "from": "noreply@bank.example",
                  "subject": "…", "codesFound": 1 } ],
  "hint": "GET /codes/:token ($0.002) returns the extracted codes themselves."
}
```

Metadata only. **Poll this while waiting** rather than paying repeatedly.

### `DELETE /mailbox/:token` — free

`{ "released": true, "mailboxToken": "…" }`, or **404** if already gone.

### `POST /verify` — free

`{ payload, signature }` → `{ valid: boolean }`.

### `GET /health` — free

```jsonc
{ "ok": true, "service": "x402-otp-relay",
  "rails": [ … ],
  "smtp": { "listening": true, "port": 2525, "domain": "relay.localhost" },
  "mailboxes": 3, "messages": 5, "domain": "relay.localhost", "ttlMs": 900000 }
```

### Error cases

| status | body | when |
|---|---|---|
| 402 | `{ x402Version, error, accepts[] }` | No/invalid/unsupported payment |
| 400 | `BAD_REQUEST` | `/verify` without `payload` + `signature` |
| 404 | `MAILBOX_NOT_FOUND` | Unknown or **expired** token |
| 500 | `no_payment_rail` | No valid payTo on either rail |
| 502 | `facilitator_unreachable` / `settlement_error` | Facilitator down; not charged |

---

## SMTP interface

The inbound MX. Unauthenticated by design — that's what an MX is.

| behaviour | detail |
|---|---|
| Recipients | `RCPT TO` is rejected with `550 5.1.1 No such mailbox` unless it matches a live mailbox on `RELAY_DOMAIN` |
| Size | Capped at 1 MB; over-size gets `552 5.3.4` |
| Parsing | `mailparser` — MIME, quoted-printable, base64, and HTML-only mail all handled |
| Extraction | Runs at delivery time, so a later poll is a cheap read |
| Retention | Newest 20 messages per mailbox; mailboxes expire on their TTL |
| Auth | `AUTH` is disabled; TLS is offered via `STARTTLS` but not required |

---

## Library API

```ts
import {
  MailboxStore, SmtpRelay, localPartFor,
  extractCodes, bestCode, htmlToText,
  paywall, paymentReceipt, sign, verify, signed,
} from "x402-otp-relay";
```

### `MailboxStore`

```ts
const store = new MailboxStore({
  domain: "relay.example.com",
  ttlMs: 15 * 60_000,          // capped at 24h
  file: "data/mailboxes.json", // or { ephemeral: true }
  maxMessages: 20,
});
```

| method | returns | notes |
|---|---|---|
| `create({ label?, ttlMs? })` | `Mailbox` | Generates the token and derives the address |
| `get(token)` | `Mailbox \| undefined` | `undefined` for unknown **or expired** |
| `accepts(address)` | `boolean` | Used by the SMTP server at RCPT time |
| `deliver({ from, to, subject, text?, html? })` | `{ delivered, codes }` | Extracts at delivery; unknown recipients dropped |
| `messages(token)` | `ReceivedMessage[] \| undefined` | Newest first |
| `codes(token)` | `ExtractedCode[] \| undefined` | De-duplicated across messages, ranked |
| `release(token)` | `boolean` | Destroy early |
| `sweep()` | `number` | Drop everything expired |
| `stats()` | `{ mailboxes, messages, domain, ttlMs }` | |

Writes are atomic (temp file + rename). Expired mailboxes are dropped on read as well as on the timer.

### `SmtpRelay`

```ts
const smtp = new SmtpRelay({
  store,
  port: 25,
  host: "0.0.0.0",
  maxSizeBytes: 1024 * 1024,
  onDelivery: ({ to, subject, codes }) => log(to, subject, codes),
});
await smtp.listen();
```

`listen()` rejects if the port can't be bound — port 25 needs root or `CAP_NET_BIND_SERVICE`. `close()` and `isListening` complete the surface.

### `extractCodes(message)` / `bestCode(message)`

The extractor, usable on any message from any source:

```ts
extractCodes({ subject?: string; text?: string; html?: string }): ExtractedCode[]
bestCode(message): ExtractedCode | null    // top non-link candidate
```

```ts
interface ExtractedCode {
  code: string;                 // the code, or the URL when kind is "link"
  kind: "numeric" | "alphanumeric" | "link";
  confidence: number;           // 0–1
  method: "labelled" | "subject" | "isolated-line" | "magic-link";
  source: "subject" | "text" | "html";
  context: string;              // ~80 chars of surrounding text
}
```

**How it decides.** Three tiers, then filters:

1. **Labelled** (0.9–0.95) — a code adjacent to "verification code", "one-time passcode", "your PIN", "OTP", and about a dozen more, in either order ("your code is X" and "X is your code").
2. **Structural** (0.7–0.75) — alone on its own line, or code-shaped in the subject.
3. **Magic links** (0.8) — a URL whose path or query says verify/confirm/activate/login, excluding unsubscribe and privacy links.

Candidates must contain a digit, be 4–10 characters, and survive rejection for: years (`2026`), prices (`$1234.56`, `1234 USD`), phone numbers and extensions, dates, order/invoice/tracking references, copyright and address footers, and being part of a longer number. Repeated characters (`0000`) and sequential runs (`123456`) are rejected **unless** a label named them — a labelled `123456` really is the code.

An alphanumeric candidate needs **at least two digits**, which is what stops the case-insensitive label patterns from matching the next English word ("This code expires…" → `expires`).

Deterministic: the same message always yields the same ranked list.

### `htmlToText(html)`

Tag stripping and entity decoding, used when a sender provides no text part.

### `localPartFor(token)`

`otp-<sha256(token) first 20 hex>`. Exported so you can reproduce an address from a token.

### `paywall(routePrices, { service, baseUrl? })`

The dual-rail x402 middleware, reusable in your own server.

---

[Tutorial](./tutorial.md) · [For AI agents](./agents.md)
