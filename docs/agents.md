# For AI agents — x402-otp-relay

Getting past "we've emailed you a code" without an inbox.

---

## 1. Discovery

| what | where | for |
|---|---|---|
| `skill.md` | [raw](https://raw.githubusercontent.com/nirholas/x402-otp-relay/main/skill.md) | Routes, prices, confidence scores, the cheap loop |
| `/.well-known/x402` | `<BASE_URL>/.well-known/x402` | Machine-readable manifest with input/output schemas |
| `openapi.json` | repo root | OpenAPI 3.1 including the 402 response |

```bash
curl -s <BASE_URL>/health | jq .smtp   # is the MX actually listening?
```

Check that before renting. A relay whose SMTP is down sells you a mailbox nothing can reach.

## 2. Paying — either rail

Every 402 lists both; pick whichever wallet you hold.

```jsonc
{
  "x402Version": 1,
  "accepts": [
    { "scheme": "exact", "network": "base-sepolia", "maxAmountRequired": "10000",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "extra": { "name": "USDC", "version": "2" } },
    { "scheme": "exact", "network": "solana", "maxAmountRequired": "10000",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "extra": { "name": "USD Coin", "decimals": 6, "feePayer": "2wKup…" } }
  ]
}
```

`extra.feePayer` sponsors the SOL network fee, so a Solana payer needs **only USDC, no SOL**.

## 3. The loop — $0.012, not $0.06

The single most important thing on this page. `/codes` costs $0.002 per call; `/messages` is free and tells you when paying is worth it.

```ts
// $0.01 — rent
const { mailbox } = await pay(`${BASE}/mailbox`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ label: runId, ttlSeconds: 600 }),
}).then(r => r.json());

const { relayAddress, mailboxToken } = mailbox.payload;

// …submit relayAddress to the signup form…

// FREE — poll until the mail lands
for (let i = 0; i < 60; i++) {
  const { messageCount } = await fetch(`${BASE}/messages/${mailboxToken}`).then(r => r.json());
  if (messageCount > 0) break;
  await new Promise(r => setTimeout(r, 1000));
}

// $0.002 — pay once
const { result } = await pay(`${BASE}/codes/${mailboxToken}`).then(r => r.json());
const code = result.payload.best?.code;

// FREE — clean up
await fetch(`${BASE}/mailbox/${mailboxToken}`, { method: "DELETE" });
```

Polling `/codes` in a loop instead costs 30× more and mostly buys empty arrays.

## 4. Two values, two rules

```
relayAddress: otp-9dc876f944af47e6978c@relay.example.com   ← PUBLIC. Submit it.
mailboxToken: cSrQEfBpVBX1nH2k…                            ← SECRET. Never submit it.
```

The address is a hash of the token. Handing the token to a signup form would be handing over the mailbox.

## 5. Reading the result

```jsonc
{
  "messageCount": 1,
  "codes": [ { "code": "481920", "kind": "numeric", "confidence": 0.95,
               "method": "labelled", "context": "481920 is your verification code" } ],
  "best": { "code": "481920", "…": "…" },
  "links": [],
  "waitedMs": 4210
}
```

| you see | what to do |
|---|---|
| `best` with confidence ≥ 0.9 | Use it. A label named it explicitly. |
| `best` with confidence 0.7–0.75 | Read `context` first. Usually right, occasionally an order reference. |
| `codes: []`, `messageCount: 0` | Mail hasn't arrived. Keep polling `/messages` — free — and don't pay again yet. |
| `codes: []`, `messageCount > 0` | Mail arrived but nothing code-shaped survived the filters. Read `messages[].subject` — it may be a welcome email rather than the verification. |
| `links` non-empty, `best` null | The site sent a **magic link**, not a code. Following it signs you in — a different action. Decide deliberately; don't paste a URL into a code field. |
| **404** `MAILBOX_NOT_FOUND` | Expired. Rent a new one; don't retry the same token. |

`waitedMs` is time since the mailbox was created. If it's approaching the TTL and nothing has arrived, the address probably never got submitted, or the site rejected the domain.

## 6. Timing

Mailboxes expire — 15 minutes by default. That's longer than any OTP's own validity, but it means:

- **Rent late.** Get the mailbox immediately before you need the address, not at the start of a long run.
- **Check `expiry`** before a slow step. If the form is going to take ten minutes to fill, ask for a longer `ttlSeconds` up front.
- **Release when done.** Free, and it's other people's verification codes.

## 7. What this is not for

The service exists so an agent can complete a verification step **for an account it is legitimately setting up or operating**. Using a disposable relay to evade identity requirements, create bulk fake accounts, or receive codes for an account that isn't yours is abuse — and in the last case, likely a crime. The operator of any deployment can see every code that passes through it.

## 8. MCP integration

[`examples/mcp-tool.md`](https://github.com/nirholas/x402-otp-relay/blob/main/examples/mcp-tool.md) exposes the cycle as Claude tools — including a `wait_for_code` tool that does the free polling internally, so the model makes one call instead of thirty.

## 9. Getting listed

- **[x402scan.com](https://x402scan.com)** — point it at your `/.well-known/x402`.
- **x402 Bazaar** — the protocol's own resource directory; same manifest format.
- **[agentic.market](https://agentic.market)** — agent-facing marketplace listing.

---

[Tutorial](./tutorial.md) · [API reference](./api.md) · Contact: nichxbt@gmail.com
