import "dotenv/config";
import express from "express";
import { readFileSync } from "node:fs";
import { activeRails, mountSolanaCheckout, paymentReceipt, paywall, usingSuiteDefaultPayTo } from "./payments.js";
import { MailboxStore } from "./mailbox.js";
import { SmtpRelay } from "./smtp.js";
import { signed, verify } from "./sign.js";
import { ROUTE_SCHEMAS } from "./schemas.js";

/**
 * x402-otp-relay — the "we've emailed you a code" step, solved for agents.
 *
 *   POST /mailbox              $0.01   → { relayAddress, mailboxToken, expiry }
 *   GET  /codes/:token         $0.002  → codes extracted from mail received so far
 *   GET  /messages/:token      free    → message metadata (no bodies), for debugging
 *   DELETE /mailbox/:token     free    → release a mailbox early
 *   POST /verify               free    → verify a signed record
 *
 * Inbound mail arrives over SMTP on its own port. Point an MX record at it and
 * real verification email lands here; in dev, send to it directly (see
 * examples/agent-client.ts, which speaks raw SMTP in about twenty lines).
 */

const port = Number(process.env.PORT || 4035);
const smtpPort = Number(process.env.SMTP_PORT || 2525);
const relayDomain = process.env.RELAY_DOMAIN || "relay.localhost";
const mailboxTtlMs = Number(process.env.MAILBOX_TTL_MS || 15 * 60 * 1000);

const store = new MailboxStore({
  domain: relayDomain,
  ttlMs: mailboxTtlMs,
  file: process.env.MAILBOX_FILE || "data/mailboxes.json",
});

const smtp = new SmtpRelay({
  store,
  port: smtpPort,
  host: process.env.SMTP_HOST,
  onDelivery: ({ to, subject, codes }) =>
    console.log(`[smtp] delivered to ${to.join(", ")} — "${subject}" (${codes} code${codes === 1 ? "" : "s"})`),
});

// Expired mailboxes are dropped on read anyway; this keeps the file from
// growing for boxes nobody ever polls again.
const sweeper = setInterval(() => store.sweep(), 60_000);
sweeper.unref?.();

const app = express();
app.use(express.json({ limit: "64kb" }));

const PRICES: Record<string, string> = {
  "POST /mailbox": "$0.01",
  "GET /codes/:token": "$0.002",
};

// `schemas` publishes each paid route's request/response contract inside the 402
// challenge (`accepts[].outputSchema`), so an agent that hits the paywall knows
// how to call the route and what it will get back without reading the OpenAPI
// document first. Generated from openapi.json — see src/schemas.ts.
app.use(paywall(PRICES, { service: "x402-otp-relay", schemas: ROUTE_SCHEMAS }));

/**
 * Rent a mailbox. The artifact is the address itself — the agent needs it
 * immediately to paste into whatever signup form triggered this.
 */
app.post("/mailbox", (req, res) => {
  const body = (req.body ?? {}) as { label?: string; ttlSeconds?: number };
  const ttlMs = body.ttlSeconds ? Math.max(60_000, Number(body.ttlSeconds) * 1000) : undefined;

  const mailbox = store.create({ label: body.label, ttlMs });
  res.json({
    mailbox: signed({
      relayAddress: mailbox.address,
      mailboxToken: mailbox.token,
      expiry: mailbox.expiresAt,
      createdAt: mailbox.createdAt,
      label: mailbox.label,
      // Repeated here because it's the thing callers most often get wrong:
      // the address is public, the token is the credential.
      pollUrl: `/codes/${mailbox.token}`,
    }),
    smtp: { host: relayDomain, port: smtpPort },
    paidWith: paymentReceipt(res),
  });
});

/**
 * Poll for codes. A pay-per-poll snapshot: mail may not have arrived yet, and
 * an empty list is a valid, paid-for answer — it tells the caller the mailbox
 * is live and still empty, which is different from "your token is wrong".
 */
app.get("/codes/:token", (req, res) => {
  const token = req.params.token;
  const mailbox = store.get(token);
  if (!mailbox) {
    res.status(404).json({
      error: "MAILBOX_NOT_FOUND",
      hint: "Unknown or expired mailboxToken. Mailboxes expire; rent a new one with POST /mailbox.",
    });
    return;
  }

  const codes = store.codes(token) ?? [];
  const messages = store.messages(token) ?? [];
  const waitedMs = Date.now() - Date.parse(mailbox.createdAt);

  res.json({
    result: signed({
      mailboxToken: token,
      relayAddress: mailbox.address,
      expiry: mailbox.expiresAt,
      messageCount: messages.length,
      // Ranked best-first. `best` is the top non-link candidate, which is what
      // an agent almost always wants to type into a form.
      codes,
      best: codes.find((c) => c.kind !== "link") ?? null,
      links: codes.filter((c) => c.kind === "link"),
      messages: messages.map((m) => ({
        id: m.id,
        receivedAt: m.receivedAt,
        from: m.from,
        subject: m.subject,
        codes: m.codes.map((c) => c.code),
      })),
      waitedMs,
      polledAt: new Date().toISOString(),
    }),
    paidWith: paymentReceipt(res),
  });
});

/** Free: enough to tell whether mail has landed, without the codes themselves. */
app.get("/messages/:token", (req, res) => {
  const messages = store.messages(req.params.token);
  if (!messages) {
    res.status(404).json({ error: "MAILBOX_NOT_FOUND", hint: "Unknown or expired mailboxToken." });
    return;
  }
  res.json({
    messageCount: messages.length,
    messages: messages.map((m) => ({
      id: m.id,
      receivedAt: m.receivedAt,
      from: m.from,
      subject: m.subject,
      codesFound: m.codes.length,
    })),
    hint: "GET /codes/:token ($0.002) returns the extracted codes themselves.",
  });
});

/** Free, and worth doing: an agent that's finished shouldn't leave codes lying around. */
app.delete("/mailbox/:token", (req, res) => {
  const released = store.release(req.params.token);
  res.status(released ? 200 : 404).json(
    released
      ? { released: true, mailboxToken: req.params.token }
      : { error: "MAILBOX_NOT_FOUND", hint: "Already released or expired." },
  );
});

app.post("/verify", (req, res) => {
  const { payload, signature } = (req.body ?? {}) as { payload?: unknown; signature?: string };
  if (payload === undefined || !signature) {
    res.status(400).json({ error: "BAD_REQUEST", hint: "POST { payload, signature }" });
    return;
  }
  res.json({ valid: verify(payload, signature) });
});

app.get("/.well-known/x402", (_req, res) => {
  res.type("application/json").send(readFileSync("public/.well-known/x402", "utf8"));
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "x402-otp-relay",
    rails: activeRails(),
    smtp: { listening: smtp.isListening, port: smtpPort, domain: relayDomain },
    ...store.stats(),
  });
});

app.use(express.static("public"));

await mountSolanaCheckout(app);

// The SMTP port is the whole product, so refuse to pretend we're healthy
// without it — an agent that rents a mailbox nothing can deliver to has paid
// for nothing.
try {
  await smtp.listen();
} catch (err) {
  console.error(
    `\nFATAL: could not bind SMTP on port ${smtpPort}: ${(err as Error).message}\n` +
      `Port 25 needs root or CAP_NET_BIND_SERVICE. In dev use SMTP_PORT=2525.\n`,
  );
  process.exit(1);
}

const server = app.listen(port, () => {
  console.log(`\nx402-otp-relay on http://localhost:${port}`);
  console.log(`SMTP listening on port ${smtpPort} for @${relayDomain}`);
  console.log("\nPayment rails (client picks one):");
  for (const rail of activeRails()) {
    console.log(`  ${rail.rail.padEnd(7)} ${rail.network.padEnd(14)} USDC → ${rail.payTo}`);
  }
  if (usingSuiteDefaultPayTo()) {
    console.log("  note: using suite default payTo — set PAY_TO_ADDRESS / SOLANA_PAY_TO_ADDRESS to receive funds yourself");
  }
  console.log(`\nMailbox TTL: ${Math.round(mailboxTtlMs / 1000)}s | live mailboxes: ${store.stats().mailboxes}`);
  console.log("\nPaid routes:");
  for (const [route, price] of Object.entries(PRICES)) console.log(`  ${route.padEnd(22)} ${price}`);
  console.log("\nFree routes:\n  GET /messages/:token\n  DELETE /mailbox/:token\n  POST /verify\n  GET /.well-known/x402\n  GET /health\n");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void (async () => {
      clearInterval(sweeper);
      await smtp.close();
      server.close(() => process.exit(0));
    })();
  });
}
