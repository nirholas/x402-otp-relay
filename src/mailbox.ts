import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { extractCodes, type ExtractedCode } from "./extract.js";

/**
 * MailboxStore — short-lived relay mailboxes and the mail that lands in them.
 *
 * A mailbox is a disposable address (`<local>@RELAY_DOMAIN`) plus a bearer
 * token. The local part is derived from the token by hash, so knowing the
 * address does not let you read the mailbox — that matters, because the address
 * is handed to a third party by design.
 *
 * Mailboxes expire. That is a feature, not housekeeping: an OTP relay that
 * keeps mail forever is a standing pile of other people's verification codes.
 * The default TTL is 15 minutes, which is longer than any OTP's own validity.
 */

export interface Mailbox {
  /** Bearer token. Also the only way to read the mailbox. */
  token: string;
  /** The address to hand to the site sending the code. */
  address: string;
  createdAt: string;
  expiresAt: string;
  /** Optional label the caller supplied, echoed back for their own bookkeeping. */
  label?: string;
  messageCount: number;
}

export interface ReceivedMessage {
  id: string;
  receivedAt: string;
  from: string;
  to: string[];
  subject: string;
  /** Plain-text body, converted from HTML when that's all the sender provided. */
  text: string;
  /** Ranked codes found in this message. */
  codes: ExtractedCode[];
}

export interface MailboxStoreOptions {
  /** Domain the relay accepts mail for. */
  domain: string;
  /** Mailbox lifetime in ms. Default 15 minutes; hard cap 24h. */
  ttlMs?: number;
  /** Persistence file. Default `data/mailboxes.json`. */
  file?: string;
  /** In-memory only. */
  ephemeral?: boolean;
  /** Messages kept per mailbox. Default 20 — a relay is not an inbox. */
  maxMessages?: number;
}

interface StoredMailbox extends Mailbox {
  messages: ReceivedMessage[];
}

const MAX_TTL_MS = 24 * 60 * 60 * 1000;

export class MailboxStore {
  private boxes = new Map<string, StoredMailbox>();
  /** local-part → token, so inbound SMTP can find the mailbox by address. */
  private byLocalPart = new Map<string, string>();

  readonly domain: string;
  readonly ttlMs: number;
  private readonly file: string;
  private readonly ephemeral: boolean;
  private readonly maxMessages: number;

  constructor(options: MailboxStoreOptions) {
    this.domain = options.domain;
    this.ttlMs = Math.min(options.ttlMs ?? 15 * 60 * 1000, MAX_TTL_MS);
    this.file = options.file ?? "data/mailboxes.json";
    this.ephemeral = options.ephemeral ?? false;
    this.maxMessages = options.maxMessages ?? 20;
    this.load();
  }

  /** Create a mailbox. The token is the credential; the address is public. */
  create(options: { label?: string; ttlMs?: number } = {}): Mailbox {
    const token = randomBytes(24).toString("base64url");
    const localPart = localPartFor(token);
    const now = Date.now();
    const ttl = Math.min(options.ttlMs ?? this.ttlMs, MAX_TTL_MS);

    const box: StoredMailbox = {
      token,
      address: `${localPart}@${this.domain}`,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
      label: options.label,
      messageCount: 0,
      messages: [],
    };

    this.boxes.set(token, box);
    this.byLocalPart.set(localPart, token);
    this.save();
    return publicView(box);
  }

  /** Look up by bearer token. Returns undefined for unknown or expired. */
  get(token: string): Mailbox | undefined {
    const box = this.live(token);
    return box ? publicView(box) : undefined;
  }

  /** Is this an address we should accept mail for? Called by the SMTP server. */
  accepts(address: string): boolean {
    const [localPart, domain] = String(address).toLowerCase().split("@");
    if (!domain || domain !== this.domain.toLowerCase()) return false;
    const token = this.byLocalPart.get(localPart);
    return !!token && !!this.live(token);
  }

  /**
   * Deliver a message. Codes are extracted at delivery time so a later poll is
   * a cheap read rather than a re-parse. Unknown or expired recipients are
   * dropped silently — an SMTP error would tell a prober which addresses exist.
   */
  deliver(message: { from: string; to: string[]; subject: string; text?: string; html?: string }): {
    delivered: string[];
    codes: number;
  } {
    const delivered: string[] = [];
    let codes = 0;

    for (const recipient of message.to) {
      const [localPart, domain] = recipient.toLowerCase().split("@");
      if (domain !== this.domain.toLowerCase()) continue;
      const token = this.byLocalPart.get(localPart);
      if (!token) continue;
      const box = this.live(token);
      if (!box) continue;

      const extracted = extractCodes({
        subject: message.subject,
        text: message.text,
        html: message.html,
      });

      const stored: ReceivedMessage = {
        id: `msg_${randomBytes(8).toString("hex")}`,
        receivedAt: new Date().toISOString(),
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text ?? "",
        codes: extracted,
      };

      box.messages.push(stored);
      if (box.messages.length > this.maxMessages) box.messages.shift();
      box.messageCount = box.messages.length;
      delivered.push(recipient);
      codes += extracted.length;
    }

    if (delivered.length > 0) this.save();
    return { delivered, codes };
  }

  /**
   * Everything received so far, newest first. This is the paid poll: it's a
   * snapshot, so a caller who polls before the mail arrives gets an empty list
   * and a `waitedMs` hint rather than an error.
   */
  messages(token: string): ReceivedMessage[] | undefined {
    const box = this.live(token);
    return box ? box.messages.map((m) => ({ ...m })).reverse() : undefined;
  }

  /** All codes across all messages in the mailbox, ranked and de-duplicated. */
  codes(token: string): ExtractedCode[] | undefined {
    const messages = this.messages(token);
    if (!messages) return undefined;
    const seen = new Set<string>();
    const all: ExtractedCode[] = [];
    for (const message of messages) {
      for (const code of message.codes) {
        const key = `${code.kind}:${code.code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(code);
      }
    }
    return all.sort((a, b) => b.confidence - a.confidence);
  }

  /** Destroy a mailbox early. An agent that's finished should call this. */
  release(token: string): boolean {
    const box = this.boxes.get(token);
    if (!box) return false;
    this.boxes.delete(token);
    this.byLocalPart.delete(localPartFor(token));
    this.save();
    return true;
  }

  /** Drop everything past its expiry. Called on a timer and before every read. */
  sweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [token, box] of this.boxes) {
      if (Date.parse(box.expiresAt) <= now) {
        this.boxes.delete(token);
        this.byLocalPart.delete(localPartFor(token));
        removed += 1;
      }
    }
    if (removed > 0) this.save();
    return removed;
  }

  stats(): { mailboxes: number; messages: number; domain: string; ttlMs: number } {
    return {
      mailboxes: this.boxes.size,
      messages: [...this.boxes.values()].reduce((sum, box) => sum + box.messages.length, 0),
      domain: this.domain,
      ttlMs: this.ttlMs,
    };
  }

  private live(token: string): StoredMailbox | undefined {
    const box = this.boxes.get(token);
    if (!box) return undefined;
    if (Date.parse(box.expiresAt) <= Date.now()) {
      this.boxes.delete(token);
      this.byLocalPart.delete(localPartFor(token));
      this.save();
      return undefined;
    }
    return box;
  }

  private load(): void {
    if (this.ephemeral || !existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as StoredMailbox[];
      for (const box of raw) {
        if (Date.parse(box.expiresAt) <= Date.now()) continue;
        this.boxes.set(box.token, box);
        this.byLocalPart.set(localPartFor(box.token), box.token);
      }
    } catch {
      // Corrupt or empty file — start fresh rather than fail to boot.
    }
  }

  private save(): void {
    if (this.ephemeral) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.boxes.values()], null, 2));
    renameSync(tmp, this.file);
  }
}

/**
 * Derive the address's local part from the token.
 *
 * A hash rather than the token itself: the address gets typed into someone
 * else's signup form and will end up in their logs, so it must not be the
 * credential that reads the mailbox.
 */
export function localPartFor(token: string): string {
  return `otp-${createHash("sha256").update(token).digest("hex").slice(0, 20)}`;
}

function publicView(box: StoredMailbox): Mailbox {
  const { messages: _messages, ...rest } = box;
  return { ...rest, messageCount: box.messages.length };
}
