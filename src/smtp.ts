import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";
import { simpleParser } from "mailparser";
import type { MailboxStore } from "./mailbox.js";

/**
 * Inbound SMTP — the half of this service that isn't HTTP.
 *
 * A real MX record points at this port and the world's verification email lands
 * here. It accepts mail only for live mailboxes, parses it with `mailparser`
 * (so MIME, quoted-printable, base64 and HTML-only mail all work), and hands it
 * to the store, which extracts the codes.
 *
 * Deliberately unauthenticated for inbound mail: that's what an MX is. The
 * protections are elsewhere — recipients must match a live mailbox, message
 * size is capped, and mailboxes expire.
 */

export interface SmtpRelayOptions {
  store: MailboxStore;
  /** Port to listen on. 25 in production behind an MX; 2525 in dev. */
  port: number;
  host?: string;
  /** Max message size in bytes. Default 1 MB — an OTP email is a few KB. */
  maxSizeBytes?: number;
  /** Called after every accepted delivery, for logging. */
  onDelivery?: (info: { to: string[]; subject: string; codes: number }) => void;
}

export class SmtpRelay {
  private server: SMTPServer;
  private listening = false;

  constructor(private readonly options: SmtpRelayOptions) {
    const { store } = options;

    this.server = new SMTPServer({
      // Inbound public mail: no auth, no TLS requirement. A submission server
      // would be the opposite; this is an MX.
      authOptional: true,
      disabledCommands: ["AUTH"],
      size: options.maxSizeBytes ?? 1024 * 1024,
      banner: "x402-otp-relay",

      onRcptTo(address, _session, callback) {
        if (!store.accepts(address.address)) {
          // 550 rather than a silent accept: telling the sender immediately is
          // better than black-holing mail. The address is a hash of a secret,
          // so this leaks nothing an attacker could enumerate.
          return callback(new Error("550 5.1.1 No such mailbox"));
        }
        callback();
      },

      onData(stream: SMTPServerDataStream, session: SMTPServerSession, callback) {
        simpleParser(stream)
          .then((parsed) => {
            if (stream.sizeExceeded) {
              callback(new Error("552 5.3.4 Message too large"));
              return;
            }

            const to = session.envelope.rcptTo.map((r) => r.address.toLowerCase());
            const from = session.envelope.mailFrom ? session.envelope.mailFrom.address : "";
            const subject = parsed.subject ?? "";

            const result = store.deliver({
              from,
              to,
              subject,
              text: parsed.text ?? undefined,
              html: typeof parsed.html === "string" ? parsed.html : undefined,
            });

            options.onDelivery?.({ to: result.delivered, subject, codes: result.codes });
            callback();
          })
          .catch((err: unknown) => {
            callback(new Error(`451 4.3.0 Could not parse message: ${(err as Error).message}`));
          });
      },
    });

    this.server.on("error", (err) => {
      console.error(`[smtp] ${err.message}`);
    });
  }

  async listen(): Promise<void> {
    if (this.listening) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once("error", onError);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", onError);
        this.listening = true;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.listening = false;
  }

  get isListening(): boolean {
    return this.listening;
  }
}
