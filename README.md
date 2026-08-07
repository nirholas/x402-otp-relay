# x402-otp-relay

**The "we've emailed you a code" step, solved for agents.** Rent a disposable relay mailbox, hand its address to whatever needs to email you, poll for the extracted code.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![x402](https://img.shields.io/badge/x402-payments-0052ff.svg)](https://x402.org)
[![rails: Base + Solana](https://img.shields.io/badge/rails-Base%20%2B%20Solana-14f195.svg)](#both-rails-always)

```bash
npm install x402-otp-relay
```

## The problem

Half the internet's signup flows end the same way: *we've sent a code to your email*. An agent with a wallet and no inbox stops dead right there — not because the task is hard, but because there is nowhere for the email to go.

This service is the inbox. Rent a mailbox for a cent, paste its address into the form, and poll for the code.

## Why x402 for this

Disposable-mailbox services are either free-and-abused or subscription-and-pointless — nobody wants a monthly plan to receive four emails. A cent per mailbox and a fifth of a cent per poll is a price that actually matches the usage, and it's a price an agent can pay without an account, a credit card, or a human.

The pricing is also the abuse control: free relays get used for bulk fake accounts, and $0.01 a mailbox makes that arithmetic much less appealing.

## Quickstart

```bash
git clone https://github.com/nirholas/x402-otp-relay && cd x402-otp-relay
npm install
cp .env.example .env
npm run dev
```

```bash
curl -s localhost:4035/health | jq '{smtp, mailboxes}'
npm run client                  # rents a mailbox, sends itself real mail over SMTP, reads the code
```

## API

| Route | Price | What you get back |
|---|---|---|
| `POST /mailbox` | **$0.01** | `{ relayAddress, mailboxToken, expiry }`, signed |
| `GET /codes/:token` | **$0.002** | Codes extracted from mail received so far, ranked with confidence |
| `GET /messages/:token` | free | Message metadata, no codes — **poll this while waiting** |
| `DELETE /mailbox/:token` | free | Release a mailbox early |
| `POST /verify` | free | Signature check on any record |
| `GET /health` | free | Liveness, rails, SMTP status, live mailbox count |

### The loop that costs $0.012

The naive version — poll `/codes` once a second for thirty seconds — costs $0.06 and mostly buys empty arrays. The free metadata poll exists precisely so you don't:

```ts
const { mailbox } = await pay(`${BASE}/mailbox`, { method: "POST" }).then(r => r.json());   // $0.01
// …paste mailbox.payload.relayAddress into the signup form…

for (let i = 0; i < 30; i++) {                                                              // free
  const { messageCount } = await fetch(`${BASE}/messages/${token}`).then(r => r.json());
  if (messageCount > 0) break;
  await new Promise(r => setTimeout(r, 1000));
}

const { result } = await pay(`${BASE}/codes/${token}`).then(r => r.json());                 // $0.002
result.payload.best.code;   // "481920"
```

## Extraction is the hard part

A verification email is a haystack full of numbers: order ids, years, prices, phone numbers, tracking codes, footer addresses. "First six digits wins" is wrong often enough to burn login attempts — and a wrong code sometimes locks the account.

So codes come back **ranked, with a confidence score, the method that found them, and the surrounding text**:

```jsonc
{
  "code": "481920",
  "kind": "numeric",
  "confidence": 0.95,
  "method": "labelled",
  "source": "subject",
  "context": "481920 is your verification code"
}
```

Three tiers, most trustworthy first:

| tier | confidence | what it is |
|---|---|---|
| **labelled** | 0.9–0.95 | Adjacent to "verification code", "one-time passcode", "your PIN" — the sender told us what it is |
| **structural** | 0.7–0.75 | Standing alone on its own line, or code-shaped in the subject |
| **magic link** | 0.8 | A URL whose path says verify/confirm/login — returned **separately**, since following one is a different action from typing a code |

Then everything is filtered against the things that merely look like codes: years, prices (`$1234.56`), phone numbers, dates, order references, copyright footers, unsubscribe links, and text that's part of a longer number. HTML-only mail is converted first, because plenty of senders never include a text part.

The extractor is exported on its own and works on any message:

```ts
import { extractCodes, bestCode } from "x402-otp-relay";

bestCode({ subject: "Verify", text: "Your verification code is 481920. Order 88123491, $12.99" });
// { code: "481920", confidence: 0.9, method: "labelled", … }   ← not the order id, not the price
```

## Real SMTP, not a webhook

Inbound mail arrives over actual SMTP, parsed with `mailparser` — so MIME, quoted-printable, base64 and HTML-only mail all work. Point an MX record at it and real verification email lands here:

```
relay.example.com.  IN  MX  10  smtp.example.com.
```

The address is a **hash of the token**, not the token:

```
POST /mailbox  →  relayAddress: otp-9dc876f944af47e6978c@relay.example.com   ← public
                  mailboxToken: cSrQEfBpVBX1nH2k…                            ← secret
```

That distinction matters. The address gets typed into someone else's form and ends up in their logs, their CRM, and probably a support ticket. It must not be the thing that can read the mailbox.

Unknown recipients get a `550`, message size is capped at 1 MB, and mailboxes expire — 15 minutes by default, longer than any OTP's own validity and short enough that this isn't a standing pile of other people's verification codes.

## Both rails, always

| rail | network | asset | payTo | facilitator |
|---|---|---|---|---|
| EVM | `base-sepolia` (or `base`) | USDC | `0x40252CFDF8B20Ed757D61ff157719F33Ec332402` | `x402.org/facilitator` |
| Solana | `solana` (or `solana-devnet`) | USDC | `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW` | `facilitator.payai.network` |

Every 402 lists both; the client picks. On Solana the facilitator's `extra.feePayer` sponsors the network fee, so payers need only USDC and no SOL.

## Use it as a library

```ts
import { MailboxStore, SmtpRelay, extractCodes } from "x402-otp-relay";

const store = new MailboxStore({ domain: "relay.example.com", ttlMs: 15 * 60_000 });
await new SmtpRelay({ store, port: 25 }).listen();

const box = store.create({ label: "signup-run-8812" });
box.address;   // otp-3f9c…@relay.example.com
box.token;     // the credential

store.codes(box.token);      // ranked codes across every message
store.messages(box.token);   // full messages, newest first
store.release(box.token);    // done
```

| export | what it is |
|---|---|
| `MailboxStore` | `create`, `get`, `accepts`, `deliver`, `messages`, `codes`, `release`, `sweep`, `stats` |
| `SmtpRelay` | `listen()`, `close()`, `isListening` — the inbound MX |
| `extractCodes(message)` / `bestCode(message)` | The extractor, usable standalone |
| `htmlToText(html)` | Tag stripping and entity decoding for HTML-only mail |
| `localPartFor(token)` | The address derivation, if you need to reproduce it |
| `paywall(routePrices, { service })` | The dual-rail x402 middleware, reusable |

## Real backend / API keys

No API keys, and no fixtures. The SMTP server is real, the parser is real, and the codes come out of real messages. The only thing standing between this and live production mail is an MX record.

In development, `RELAY_DOMAIN=relay.localhost` resolves to nothing externally — but you can still deliver straight to the SMTP port, which is exactly what `examples/agent-client.ts` does in about twenty lines of raw SMTP.

`SIGNING_SECRET` signs mailbox and code records; it has a dev default and must be set before you expose the service.

## What this is not for

The service exists so an agent can complete a verification step **for an account it is legitimately setting up or operating**. Using a disposable relay to evade a service's identity requirements, create bulk fake accounts, or receive codes for an account that isn't yours is abuse — and in the last case, likely a crime. If you run a deployment, you can see every code that passes through it; treat that accordingly, and set a short TTL.

## For AI agents

- **`skill.md`** — the agent-facing contract: routes, prices, confidence scores, the $0.012 loop.
- **`/.well-known/x402`** — machine-readable manifest with input/output schemas.
- **`openapi.json`** — OpenAPI 3.1 including the 402 response.
- **MCP** — `examples/mcp-tool.md` exposes the whole rent → wait → read cycle as Claude tools.
- **Discovery** — list your deployment on [x402scan.com](https://x402scan.com), the x402 Bazaar, and [agentic.market](https://agentic.market).

## Docs

Full docs: **https://nirholas.github.io/x402-otp-relay/** — [tutorial](https://nirholas.github.io/x402-otp-relay/tutorial), [API reference](https://nirholas.github.io/x402-otp-relay/api), [for agents](https://nirholas.github.io/x402-otp-relay/agents).

## Support

Questions, bugs, integrations: **nichxbt@gmail.com**

Part of the [x402 Suite](https://github.com/nirholas/x402-suite).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
