# Tutorial — x402-otp-relay

Rent a mailbox, deliver real mail to it over SMTP, read the code out.

---

## 1. Install

```bash
git clone https://github.com/nirholas/x402-otp-relay
cd x402-otp-relay
npm install
cp .env.example .env
```

Node 18+.

## 2. Run it

```bash
npm run dev
```

```
x402-otp-relay on http://localhost:4035
SMTP listening on port 2525 for @relay.localhost

Payment rails (client picks one):
  evm     base-sepolia   USDC → 0x40252CFDF8B20Ed757D61ff157719F33Ec332402
  solana  solana         USDC → WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW

Mailbox TTL: 900s | live mailboxes: 0

Paid routes:
  POST /mailbox          $0.01
  GET /codes/:token      $0.002
```

Two listeners, and both matter. The HTTP port sells mailboxes; the SMTP port is where the mail actually arrives. If SMTP can't bind, the server **refuses to start** — an agent that rents a mailbox nothing can deliver to has paid for nothing.

```bash
curl -s localhost:4035/health | jq .smtp
# { "listening": true, "port": 2525, "domain": "relay.localhost" }
```

## 3. Your first 402

```bash
curl -s -X POST localhost:4035/mailbox -H 'content-type: application/json' -d '{}' \
  | jq -r '.accepts[] | "\(.network)\t$\(.maxAmountRequired|tonumber/1000000)"'
```

```
base-sepolia	$0.01
solana	$0.01
```

## 4. Rent a mailbox

Fund a Base Sepolia wallet at [faucet.circle.com](https://faucet.circle.com), then:

```bash
PRIVATE_KEY=0xyourTestKey npm run client
```

```
Mailbox rented:
  address (public) otp-9dc876f944af47e6978c@relay.localhost      ← paste this into the signup form
  token   (secret) cSrQEfBpVBX1…   ← this reads the mailbox
  expires          2026-08-07T16:10:00.000Z
```

**The address and the token are different things on purpose.** The address gets typed into someone else's form and ends up in their logs, their CRM, and probably a support ticket. It's a SHA-256 hash of the token, so knowing it tells you nothing about how to read the mailbox.

## 5. Something emails it

The example script sends itself a message by speaking raw SMTP to the relay port — about twenty lines, and exactly what a real sender does minus the DNS lookup:

```
(a verification email has been delivered over SMTP)
```

You'll see it land in the server log:

```
[smtp] delivered to otp-9dc876f944af47e6978c@relay.localhost — "481920 is your verification code" (1 code)
```

Try it by hand if you like:

```bash
printf 'EHLO test\r\nMAIL FROM:<a@b.c>\r\nRCPT TO:<otp-...@relay.localhost>\r\nDATA\r\nSubject: Your code\r\n\r\nYour verification code is 481920.\r\n.\r\nQUIT\r\n' \
  | nc localhost 2525
```

An unknown recipient gets `550 5.1.1 No such mailbox` — the address is a hash of a secret, so this leaks nothing enumerable.

## 6. Poll for free while you wait

This is the part that makes the service cheap to use:

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

Metadata only, no codes, **free**. Poll it until `messageCount > 0`, then pay once. The naive alternative — polling `/codes` every second for thirty seconds — costs $0.06 and mostly buys empty arrays.

## 7. Pay once for the code

```bash
curl -s localhost:4035/codes/$TOKEN -H "X-PAYMENT: $X_PAYMENT" | jq .result.payload.codes
```

```jsonc
[
  {
    "code": "481920",
    "kind": "numeric",
    "confidence": 0.95,
    "method": "labelled",
    "source": "subject",
    "context": "481920 is your verification code"
  }
]
```

Now look at what the email actually contained:

```
Your verification code is 481920.
It expires in 10 minutes. Never share it with anyone.
Order 88123491 · Total $1234.56 · Support +1 415 555 0132
© 2026 Bank Example, Suite 400
```

Five other number-shaped things — an order id, a price, a phone number, a copyright year, a suite number — and none of them came back. That filtering is most of the value here.

## 8. Reading the confidence

| confidence | method | what it means |
|---|---|---|
| 0.95 | `labelled` | A label named it, in the subject. Type this one. |
| 0.9 | `labelled` | A label named it in the body — "your verification code is X". |
| 0.8 | `magic-link` | A verify/confirm/login URL. **Following it is a different action** — decide deliberately. |
| 0.75 | `isolated-line` | Stood alone on its own line. Common layout, slightly less certain. |
| 0.7 | `subject` | Code-shaped in the subject, unlabelled. Weakest — read `context`. |

`best` is the top-ranked non-link candidate. `links` is kept separate for exactly that reason: clicking a magic link logs you in, which is not the same as having a code to type.

When confidence is below 0.9, read `context`. It's usually immediately obvious whether the number is the code or a reference.

## 9. Clean up

```bash
curl -s -X DELETE localhost:4035/mailbox/$TOKEN
# { "released": true, "mailboxToken": "…" }
```

Free, and worth doing. Mailboxes expire on their own, but leaving other people's verification codes sitting on a server is not a good habit.

**Total for a complete verification: $0.012.**

## 10. As a library

```ts
import { MailboxStore, SmtpRelay, extractCodes } from "x402-otp-relay";

const store = new MailboxStore({ domain: "relay.example.com", ttlMs: 15 * 60_000 });
await new SmtpRelay({ store, port: 25 }).listen();

const box = store.create({ label: "signup-run-8812" });
// …use box.address…
store.codes(box.token);
store.release(box.token);
```

The extractor works standalone on any message, which is handy if you already have an inbox and only want the parsing:

```ts
extractCodes({ subject: "Verify", text: "Your code is 481920. Order 88123491, $12.99" });
// [{ code: "481920", confidence: 0.9, method: "labelled", … }]
```

## 11. Going to production

The one thing that turns this from a demo into a service is **DNS**:

```
relay.example.com.  IN  MX  10  smtp.example.com.
smtp.example.com.   IN  A       203.0.113.10
```

```bash
RELAY_DOMAIN=relay.example.com
SMTP_PORT=25
NETWORK=base
SOLANA_NETWORK=mainnet-beta
FACILITATOR_URL=https://facilitator.payai.network
SOLANA_FACILITATOR_URL=https://facilitator.payai.network
PAY_TO_ADDRESS=0xYourRealWallet
SOLANA_PAY_TO_ADDRESS=YourRealSolanaWallet
SIGNING_SECRET=$(openssl rand -hex 32)
MAILBOX_TTL_MS=600000
```

Checklist:

- **Port 25 needs privileges.** Grant them narrowly — `setcap cap_net_bind_service=+ep $(which node)` — or terminate on 25 at a proxy and forward to 2525. Don't run the whole thing as root.
- **Set `SIGNING_SECRET`**, or records are signed with a public dev key and prove nothing.
- **Keep the TTL short.** Ten minutes is plenty. Every extra minute is more of other people's codes sitting on your disk.
- **Don't log message bodies.** The delivery log deliberately records subject and code count, not content. Keep it that way.
- **Expect spam.** An open MX gets scanned within hours. Unknown recipients are rejected at RCPT and the 1 MB cap is enforced, but put a rate limit in front of it.
- **You can see every code.** That's an inherent property of running a relay. Say so in your terms, and treat the data as sensitive.

---

Next: [API reference](./api.md) · [For AI agents](./agents.md)
