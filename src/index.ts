/**
 * x402-otp-relay — the "we've emailed you a code" step, solved for agents.
 *
 * Rent a disposable relay mailbox, hand its address to whatever wants to email
 * you a verification code, then poll for the extracted code. Inbound mail
 * arrives over real SMTP; the extractor is the interesting part.
 *
 * @example
 * ```ts
 * import { MailboxStore, SmtpRelay, extractCodes } from "x402-otp-relay";
 *
 * const store = new MailboxStore({ domain: "relay.example.com", ttlMs: 15 * 60_000 });
 * await new SmtpRelay({ store, port: 25 }).listen();
 *
 * const box = store.create({ label: "signup-run-8812" });
 * box.address;   // otp-3f9c…@relay.example.com  → paste into the signup form
 * box.token;     // the credential that reads it
 *
 * // …once the mail lands:
 * store.codes(box.token);
 * // [{ code: "481920", kind: "numeric", confidence: 0.9, method: "labelled", context: "…" }]
 * ```
 *
 * The extractor is usable on its own, against any message:
 *
 * ```ts
 * extractCodes({ subject: "Verify", text: "Your verification code is 481920." });
 * ```
 */

export {
  MailboxStore,
  localPartFor,
  type Mailbox,
  type ReceivedMessage,
  type MailboxStoreOptions,
} from "./mailbox.js";

export { SmtpRelay, type SmtpRelayOptions } from "./smtp.js";

export {
  extractCodes,
  bestCode,
  htmlToText,
  type ExtractedCode,
  type ExtractInput,
  type CodeKind,
} from "./extract.js";

export {
  paywall,
  paymentReceipt,
  activeRails,
  routeMatches,
  usingSuiteDefaultPayTo,
  mountSolanaCheckout,
  DEFAULT_EVM_PAY_TO,
  DEFAULT_SOLANA_PAY_TO,
  type PaymentReceipt,
  type PaywallOptions,
  type RailInfo,
  type RoutePrices,
  type RouteSchema,
} from "./payments.js";

export { sign, verify, signed, canonicalize, type SignedRecord } from "./sign.js";
