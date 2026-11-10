---
name: relay-verification-codes
description: Run the x402-otp-relay HTTP service, rent a disposable relay mailbox, and retrieve the verification code that a site emails to it. Use when an agent hits a signup or login step that emails a code and can pay per mailbox and per code in USDC over x402.
---

# x402-otp-relay

x402-otp-relay rents a disposable mailbox. You paste the `relayAddress` into a form, the site's email arrives over real SMTP, and the service returns extracted codes ranked with a confidence score, the method that found them and surrounding text. `relayAddress` is public; `mailboxToken` is the credential for reading it.

Paying is irreversible. Before any paid call, show the user the route, price, network and payTo address from the 402 response, and wait for an explicit yes.

## Run the service

From a clone (Node 18+):

```bash
git clone https://github.com/nirholas/x402-otp-relay
cd x402-otp-relay && npm install
npm run dev        # tsx src/server.ts, listens on :4035 (PORT overrides)
```

Environment (see `.env.example`): `RELAY_DOMAIN` (mailbox address domain), `SMTP_PORT` (inbound SMTP, default 2525), `SMTP_HOST`, `MAILBOX_TTL_MS` (default 900000), `MAILBOX_FILE`, `SIGNING_SECRET`. Real mail only arrives if an MX record for `RELAY_DOMAIN` points at the SMTP listener. Payment settings: `PAY_TO_ADDRESS` (Base receive address), `SOLANA_PAY_TO_ADDRESS`, `NETWORK` (`base-sepolia` default, or `base`), `SOLANA_NETWORK`, `FACILITATOR_URL`, `PUBLIC_BASE_URL`. Set your own pay-to addresses to be paid yourself. `npm run build` then `npm start` runs the compiled server.

## Routes

| Route | Price | Notes |
|---|---|---|
| `POST /mailbox` | $0.01 | optional body `label`, `ttlSeconds` (min 60, capped by server TTL); returns `relayAddress` and `mailboxToken` |
| `GET /codes/:token` | $0.002 | ranked `codes` plus `best` (top non-link candidate) and `links`; empty `codes` is a valid paid answer meaning mail has not arrived |
| `GET /messages/:token` | free | message metadata and `messageCount`; poll this while waiting |
| `DELETE /mailbox/:token` | free | release the mailbox when done |
| `POST /verify` | free | `{payload, signature}` returns `{valid}` |
| `GET /health` | free | liveness, SMTP listener state, mailbox counts |

## Paying

An unpaid request to a paid route returns 402 with an `accepts` array listing both rails (USDC on Base or Solana). Sign the entry your wallet supports and retry with the base64 `X-PAYMENT` header. The settlement receipt is in the `X-PAYMENT-RESPONSE` header. The reference client is `examples/agent-client.ts` (`npm run client`), which uses `x402-fetch` with `PRIVATE_KEY` for a Base Sepolia wallet and `BASE_URL` (default `http://localhost:4035`).

Confidence scores: 0.95 and 0.9 are `labelled` (a label such as "your verification code is" names it), 0.8 is a `magic-link` URL, 0.75 an `isolated-line`, 0.7 a code-shaped token in the subject. Read the `context` field when confidence is below 0.9. Following a magic link is a different action from typing a code, so decide that deliberately with the user.

## Example

```bash
curl -i -X POST localhost:4035/mailbox -H 'content-type: application/json' -d '{"label":"signup","ttlSeconds":600}'
# 402 first. After payment: use relayAddress in the signup form, then
curl localhost:4035/messages/<mailboxToken>      # free, repeat until messageCount > 0
# pay once for GET /codes/<mailboxToken>, read best.value, then DELETE /mailbox/<mailboxToken>
```
