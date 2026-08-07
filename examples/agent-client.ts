/**
 * The full cycle: rent a mailbox, have a real email delivered to it over SMTP,
 * poll for free until it lands, then pay once for the code.
 *
 *   PRIVATE_KEY=0x… npx tsx examples/agent-client.ts
 *
 * Without PRIVATE_KEY the script stops at the 402 and prints the challenge.
 *
 * The email is sent by speaking raw SMTP to the relay's own port — which is
 * exactly what a real sender does, minus the DNS lookup. In production the MX
 * record for RELAY_DOMAIN points here and the mail arrives on its own.
 */
import net from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4035";
const SMTP_HOST = process.env.SMTP_HOST ?? "127.0.0.1";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 2525);

// ── 1. Unpaid request: see what the service accepts ─────────────────────────
const challenge = await fetch(`${BASE_URL}/mailbox`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ label: "example-run" }),
});

if (challenge.status !== 402) {
  console.error(`Expected 402, got ${challenge.status}. Is the server running?`);
  process.exit(1);
}

const { accepts } = (await challenge.json()) as {
  accepts: { network: string; maxAmountRequired: string; payTo: string }[];
};

console.log("402 Payment Required — this service accepts:");
for (const accept of accepts) {
  console.log(
    `  ${accept.network.padEnd(14)} $${(Number(accept.maxAmountRequired) / 1e6).toFixed(3)} USDC → ${accept.payTo}`,
  );
}

if (!process.env.PRIVATE_KEY) {
  console.log("\nSet PRIVATE_KEY (a funded base-sepolia wallet) to rent a mailbox and read a code.");
  process.exit(0);
}

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const pay = wrapFetchWithPayment(fetch, account);

// ── 2. Rent a mailbox ($0.01) ───────────────────────────────────────────────
const rented = await pay(`${BASE_URL}/mailbox`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ label: "example-run", ttlSeconds: 600 }),
});

const { mailbox } = (await rented.json()) as {
  mailbox: { payload: { relayAddress: string; mailboxToken: string; expiry: string } };
};
const { relayAddress, mailboxToken, expiry } = mailbox.payload;

const receiptHeader = rented.headers.get("x-payment-response");
if (receiptHeader) console.log("\nX-PAYMENT-RESPONSE:", decodeXPaymentResponse(receiptHeader));

console.log(`\nMailbox rented:`);
console.log(`  address (public) ${relayAddress}      ← paste this into the signup form`);
console.log(`  token   (secret) ${mailboxToken.slice(0, 12)}…   ← this reads the mailbox`);
console.log(`  expires          ${expiry}`);

// ── 3. Something emails the address ─────────────────────────────────────────
// Standing in for the site you just signed up to.
await sendMail(
  relayAddress,
  `From: Bank Example <noreply@bank.example>
To: <${relayAddress}>
Subject: 481920 is your verification code
Content-Type: text/plain; charset=utf-8

Hi,

Your verification code is 481920.

It expires in 10 minutes. Never share it with anyone.

Order 88123491 · Total $1234.56 · Support +1 415 555 0132

© 2026 Bank Example, Suite 400`,
);
console.log("\n(a verification email has been delivered over SMTP)");

// ── 4. Poll for FREE until the mail lands ───────────────────────────────────
// This is the whole trick. /codes costs $0.002 per call; /messages is free and
// tells you when it's worth paying. Polling /codes in a loop would cost 30×.
let landed = false;
for (let attempt = 0; attempt < 30; attempt++) {
  const { messageCount } = (await fetch(`${BASE_URL}/messages/${mailboxToken}`).then((r) => r.json())) as {
    messageCount: number;
  };
  if (messageCount > 0) {
    landed = true;
    console.log(`mail arrived after ${attempt + 1} free poll(s)`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!landed) console.log("no mail after 15s — paying anyway to see the empty snapshot");

// ── 5. Pay once for the code ($0.002) ───────────────────────────────────────
const codesRes = await pay(`${BASE_URL}/codes/${mailboxToken}`);
const { result } = (await codesRes.json()) as {
  result: {
    payload: {
      messageCount: number;
      codes: { code: string; kind: string; confidence: number; method: string; context: string }[];
      best: { code: string; confidence: number; method: string } | null;
      links: { code: string }[];
      waitedMs: number;
    };
    signature: string;
  };
};

console.log(`\n${codesRes.status} — ${result.payload.messageCount} message(s), waited ${result.payload.waitedMs}ms`);
console.log("\nRanked codes:");
for (const code of result.payload.codes) {
  console.log(`  ${code.code.padEnd(10)} ${String(code.confidence).padEnd(5)} ${code.method.padEnd(14)} "${code.context}"`);
}
console.log(`\nBest: ${result.payload.best?.code ?? "(none yet)"}`);

// Note what did NOT come back: 88123491 (order id), 1234.56 (a price),
// 4155550132 (a phone number), 2026 (a copyright year), 400 (a suite number).

// ── 6. Clean up (free) ──────────────────────────────────────────────────────
await fetch(`${BASE_URL}/mailbox/${mailboxToken}`, { method: "DELETE" });
console.log("\nMailbox released. Total spent: $0.012");

// ── 7. The record is signed ─────────────────────────────────────────────────
const valid = await fetch(`${BASE_URL}/verify`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(result),
}).then((r) => r.json());
console.log("Codes record signature valid:", valid.valid);

/** Speak just enough SMTP to deliver one message. */
async function sendMail(to: string, raw: string): Promise<void> {
  const script = ["EHLO example-client.local", "MAIL FROM:<noreply@bank.example>", `RCPT TO:<${to}>`, "DATA"];
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: SMTP_HOST, port: SMTP_PORT });
    let stage = 0;
    socket.on("data", () => {
      if (stage < script.length) {
        socket.write(`${script[stage++]}\r\n`);
        return;
      }
      if (stage === script.length) {
        // The lone "." on its own line is what ends a DATA block.
        socket.write(`${raw.replace(/\n/g, "\r\n")}\r\n.\r\n`);
        stage++;
        return;
      }
      socket.write("QUIT\r\n");
      socket.end();
      resolve();
    });
    socket.on("error", reject);
  });
}

// ── Paying on Solana instead ────────────────────────────────────────────────
//
// The same 402 also offers `network: "solana"`. Build an SPL USDC
// transferChecked to `payTo` — the facilitator's `extra.feePayer` sponsors the
// SOL fee, so no SOL is needed — sign it, and send the base64 payload:
//
//   import { prepareSolanaCheckout, encodeX402Payment }
//     from "@three-ws/x402-payment-modal/server";
//
//   const accept = accepts.find(a => a.network.startsWith("solana"))!;
//   const { tx_base64 } = await prepareSolanaCheckout({ accept, buyer: wallet.publicKey.toBase58() });
//   const signedTx = await wallet.signTransaction(tx_base64);
//   const { x_payment } = encodeX402Payment({ accept, signedTxBase64: signedTx, resourceUrl });
//   await fetch(resourceUrl, { method: "POST", headers: { "X-PAYMENT": x_payment } });
//
// Or with x402-fetch, pass a multi-network signer and let it choose:
//
//   import { createSigner } from "x402-fetch";
//   const pay = wrapFetchWithPayment(fetch, {
//     evm: await createSigner("base-sepolia", process.env.EVM_KEY!),
//     svm: await createSigner("solana", process.env.SOLANA_KEY!),
//   });
