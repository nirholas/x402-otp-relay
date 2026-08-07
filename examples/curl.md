# Raw curl walkthrough — 402 → pay → 200

Against `npm run dev` on `localhost:4035` (HTTP) and `2525` (SMTP).

## 1. Free first

```bash
curl -s localhost:4035/health | jq '{smtp, mailboxes, ttlMs}'
```

```jsonc
{ "smtp": { "listening": true, "port": 2525, "domain": "relay.localhost" },
  "mailboxes": 0, "ttlMs": 900000 }
```

If `smtp.listening` is false, don't rent — nothing can deliver to the mailbox.

## 2. Ask without paying

```bash
curl -i -s -X POST localhost:4035/mailbox -H 'content-type: application/json' -d '{"label":"demo"}'
```

```http
HTTP/1.1 402 Payment Required
Access-Control-Expose-Headers: x-payment-response
```

```jsonc
{
  "x402Version": 1,
  "error": "X-PAYMENT header is required",
  "accepts": [
    { "scheme": "exact", "network": "base-sepolia", "maxAmountRequired": "10000",
      "resource": "http://localhost:4035/mailbox",
      "description": "x402-otp-relay: POST /mailbox",
      "mimeType": "application/json",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "maxTimeoutSeconds": 60,
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "extra": { "name": "USDC", "version": "2" } },
    { "scheme": "exact", "network": "solana", "maxAmountRequired": "10000",
      "resource": "http://localhost:4035/mailbox",
      "description": "x402-otp-relay: POST /mailbox",
      "mimeType": "application/json",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
      "maxTimeoutSeconds": 60,
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "extra": { "name": "USD Coin", "decimals": 6,
                 "feePayer": "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4", "amount": "10000" } }
  ]
}
```

## 3. Rent a mailbox ($0.01)

Produce the header with an x402 client (`npm run client`, or see [`agent-client.ts`](./agent-client.ts)):

```bash
curl -s -X POST localhost:4035/mailbox \
  -H 'content-type: application/json' -H "X-PAYMENT: $X_PAYMENT" \
  -d '{"label":"demo","ttlSeconds":600}' | jq .mailbox.payload
```

```jsonc
{
  "relayAddress": "otp-9dc876f944af47e6978c@relay.localhost",
  "mailboxToken": "cSrQEfBpVBX1nH2k…",
  "expiry": "2026-08-07T16:10:00.000Z",
  "createdAt": "2026-08-07T16:00:00.000Z",
  "label": "demo",
  "pollUrl": "/codes/cSrQEfBpVBX1nH2k…"
}
```

```bash
ADDR=otp-9dc876f944af47e6978c@relay.localhost
TOKEN=cSrQEfBpVBX1nH2k…
```

**`ADDR` is public. `TOKEN` is not.** The address is `otp-<sha256(token)[0:20]>@<domain>` — knowing it gets you nowhere.

## 4. Deliver an email

Real SMTP, by hand:

```bash
printf 'EHLO test.local\r\nMAIL FROM:<noreply@bank.example>\r\nRCPT TO:<%s>\r\nDATA\r\nFrom: Bank Example <noreply@bank.example>\r\nSubject: 481920 is your verification code\r\n\r\nHi,\r\n\r\nYour verification code is 481920.\r\n\r\nIt expires in 10 minutes.\r\nOrder 88123491 - Total $1234.56 - Support +1 415 555 0132\r\n\r\n(c) 2026 Bank Example, Suite 400\r\n.\r\nQUIT\r\n' "$ADDR" | nc localhost 2525
```

```
220 host ESMTP x402-otp-relay
250-host Nice to meet you
250 Accepted
250 Accepted
354 End data with <CR><LF>.<CR><LF>
250 OK: message queued
```

An unknown recipient:

```bash
printf 'EHLO t\r\nMAIL FROM:<a@b.c>\r\nRCPT TO:<otp-nope@relay.localhost>\r\nQUIT\r\n' | nc localhost 2525 | grep 550
# 550 5.1.1 No such mailbox
```

## 5. Poll for FREE

```bash
curl -s localhost:4035/messages/$TOKEN | jq
```

```jsonc
{
  "messageCount": 1,
  "messages": [
    { "id": "msg_a1b2c3d4", "receivedAt": "2026-08-07T16:00:04.210Z",
      "from": "noreply@bank.example",
      "subject": "481920 is your verification code", "codesFound": 1 }
  ],
  "hint": "GET /codes/:token ($0.002) returns the extracted codes themselves."
}
```

Loop this, not `/codes`:

```bash
until [ "$(curl -s localhost:4035/messages/$TOKEN | jq .messageCount)" -gt 0 ]; do sleep 1; done
```

## 6. Pay once for the code ($0.002)

```bash
curl -s localhost:4035/codes/$TOKEN -H "X-PAYMENT: $X_PAYMENT" | jq '.result.payload | {codes, best, links, waitedMs}'
```

```jsonc
{
  "codes": [
    { "code": "481920", "kind": "numeric", "confidence": 0.95,
      "method": "labelled", "source": "subject",
      "context": "481920 is your verification code" }
  ],
  "best": { "code": "481920", "confidence": 0.95, "method": "labelled", "…": "…" },
  "links": [],
  "waitedMs": 4210
}
```

Just the code:

```bash
curl -s localhost:4035/codes/$TOKEN -H "X-PAYMENT: $X_PAYMENT" | jq -r '.result.payload.best.code'
# 481920
```

What did **not** come back, from the same email: `88123491` (order id), `1234.56` (price), `4155550132` (phone), `2026` (copyright year), `400` (suite number).

## 7. Clean up

```bash
curl -s -X DELETE localhost:4035/mailbox/$TOKEN
# { "released": true, "mailboxToken": "cSrQEfBpVBX1nH2k…" }
```

Total: **$0.012**.

## 8. Verify a record

```bash
curl -s -X POST localhost:4035/verify -H 'content-type: application/json' \
  -d "$(curl -s localhost:4035/codes/$TOKEN -H "X-PAYMENT: $X_PAYMENT" | jq -c .result)"
# { "valid": true }
```

## 9. Errors you'll actually hit

```bash
# Expired or unknown token — note this is 404, not an empty result
curl -s localhost:4035/codes/nonsense -H "X-PAYMENT: $X_PAYMENT" | jq
# { "error": "MAILBOX_NOT_FOUND", "hint": "Unknown or expired mailboxToken. Mailboxes expire; rent a new one." }

# Mail hasn't landed yet — 200 with an empty list, and you paid for it
# { "codes": [], "best": null, "messageCount": 0, "waitedMs": 1200 }

# Garbage payment header  → 402 "invalid X-PAYMENT header: …"
# Wrong network signed    → 402 "unsupported rail: …"
# Facilitator down        → 502 { "error": "facilitator_unreachable" }   (not charged)
```
