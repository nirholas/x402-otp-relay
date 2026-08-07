/**
 * OTP extraction — the part that actually has to be good.
 *
 * A verification email is a haystack full of numbers: order ids, years, prices,
 * phone numbers, tracking codes, unsubscribe tokens. Grabbing "the first
 * 6-digit run" gets it wrong often enough to be useless in an agent loop, where
 * a wrong code burns a login attempt and sometimes locks the account.
 *
 * So the extractor works in three tiers, most trustworthy first:
 *
 *   1. **Labelled** — a code adjacent to words like "verification code",
 *      "one-time passcode", "your PIN". Highest confidence, because the sender
 *      told us what it is.
 *   2. **Structural** — a code standing alone on its own line, or in the
 *      subject, in the shape codes usually take. Medium confidence.
 *   3. **Magic links** — a URL whose path or query says verify/confirm/login.
 *      Returned separately, because clicking one is a different action.
 *
 * Every candidate is then filtered against the things that *look* like codes
 * but never are (years, prices, phone numbers, dates, long ids) and scored.
 * Callers get the ranked list plus the surrounding text, so an agent can make
 * its own judgement rather than trusting a single guess.
 */

export type CodeKind = "numeric" | "alphanumeric" | "link";

export interface ExtractedCode {
  /** The code itself, or the URL for `kind: "link"`. */
  code: string;
  kind: CodeKind;
  /** 0–1. Above 0.8 means a label named it explicitly. */
  confidence: number;
  /** How it was found, for debugging a miss. */
  method: "labelled" | "subject" | "isolated-line" | "magic-link";
  /** Where in the message it came from. */
  source: "subject" | "text" | "html";
  /** ~80 characters of surrounding text, so a caller can sanity-check it. */
  context: string;
}

/** Words that introduce a code. Ordered roughly by how unambiguous they are. */
const LABELS = [
  "one-?time (?:pass(?:word|code)|code|pin)",
  "verification (?:code|pin|number)",
  "confirmation (?:code|pin|number)",
  "security (?:code|pin)",
  "authentication code",
  "login code",
  "sign-?in code",
  "access code",
  "auth(?:orisation|orization)? code",
  "otp",
  "2fa code",
  "passcode",
  "pass ?code",
  "your code",
  "temporary (?:code|password)",
  "pin(?: code| number)?",
  "code",
];

/**
 * A plausible code: 4–10 digits, a grouped 3-3 numeric, or an alphanumeric run
 * containing **at least two digits**.
 *
 * That last constraint matters more than it looks. The label patterns below are
 * case-insensitive, so a naive `[A-Z0-9]{4,10}` happily matches the next
 * ordinary word — "This code expires in 5 minutes" yields the code "expires".
 * Requiring two digits rules out English while still accepting real mixed codes
 * like `4A9C2F`.
 */
const CODE_TOKEN =
  "([0-9]{4,10}|[0-9]{3}[- ][0-9]{3}|(?=[A-Za-z0-9]*[0-9][A-Za-z0-9]*[0-9])[A-Za-z0-9]{4,10})";

/**
 * Things that look like codes but never are.
 *
 * `labelled` loosens the filter: when the sender wrote "your verification code
 * is 123456", a sequential run is the code, however placeholder-ish it looks.
 * Unlabelled, the same digits are far more likely to be sample text.
 */
function isFalsePositive(raw: string, labelled = false): boolean {
  const code = raw.replace(/[\s-]/g, "");

  // Years, and the "20xx" in every copyright footer.
  if (/^(19|20)\d{2}$/.test(code)) return true;
  // Long enough to be an order or tracking id rather than something hand-typed.
  if (code.length > 10) return true;
  // No digits at all — an ordinary word that happened to be capitalised.
  if (!/[0-9]/.test(code)) return true;

  if (!labelled) {
    // Repeated single character: 0000, 1111 — real senders avoid these.
    if (/^(.)\1+$/.test(code)) return true;
    // Straight runs, which unlabelled are almost always placeholder text.
    if (["123456", "12345678", "1234", "0123456789", "123456789"].includes(code)) return true;
  }

  return false;
}

/** Reject a numeric candidate whose surroundings say "this is money/a date/a phone number". */
function contextRejects(context: string, code: string): boolean {
  const window = context.toLowerCase();
  const at = context.indexOf(code);
  const before = at >= 0 ? context.slice(Math.max(0, at - 14), at) : "";
  const after = at >= 0 ? context.slice(at + code.length, at + code.length + 14) : "";

  // Currency immediately before or after: $12.3456, 1234 USD
  if (/[$£€]\s*$/.test(before)) return true;
  if (/^\s*(usd|eur|gbp|usdc)\b/i.test(after)) return true;
  // Part of a longer number, a decimal, or a version string. The dot must be
  // followed (or preceded) by a digit to count — otherwise every code at the
  // end of a sentence is rejected for its full stop, which is most of them.
  if (/\d$/.test(before) || /\d\.$/.test(before)) return true;
  if (/^\d/.test(after) || /^\.\d/.test(after)) return true;
  // Phone numbers and extensions.
  if (/(?:\+|tel|phone|call|ext\.?)\s*[\d\s()-]*$/i.test(before)) return true;
  // Dates: 2026-08-07, 07/08/2026
  if (/[/-]\s*$/.test(before) && /^\s*[/-]/.test(after)) return true;
  // Explicitly not-the-code language.
  if (/(?:order|invoice|ticket|reference|tracking|account)\s*(?:no\.?|number|#|id)?\s*:?\s*$/i.test(before)) {
    return true;
  }
  // Copyright / address noise.
  if (/(?:©|copyright|suite|apt|zip|postal)\s*$/i.test(before)) return true;
  if (window.includes("unsubscribe") && window.length < 120) return true;

  return false;
}

function snippet(haystack: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(haystack.length, index + length + 40);
  return `${start > 0 ? "…" : ""}${haystack.slice(start, end).replace(/\s+/g, " ").trim()}${end < haystack.length ? "…" : ""}`;
}

/** Strip tags and decode the handful of entities that matter, so HTML-only mail still works. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<td[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

export interface ExtractInput {
  subject?: string;
  text?: string;
  html?: string;
}

/**
 * Pull every plausible code out of a message, ranked by confidence.
 * Deterministic: the same message always yields the same list in the same order.
 */
export function extractCodes(message: ExtractInput): ExtractedCode[] {
  const subject = message.subject ?? "";
  const text = message.text ?? (message.html ? htmlToText(message.html) : "");
  const found: ExtractedCode[] = [];
  const seen = new Set<string>();

  const add = (candidate: ExtractedCode) => {
    const key = `${candidate.kind}:${candidate.code}`;
    const existing = found.find((f) => `${f.kind}:${f.code}` === key);
    if (existing) {
      // Same code found twice — keep the more confident sighting.
      if (candidate.confidence > existing.confidence) Object.assign(existing, candidate);
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    found.push(candidate);
  };

  // ── Tier 1: labelled codes ────────────────────────────────────────────────
  // "your verification code is 481920", "OTP: 4A9C2F", "code — 123 456".
  const labelPattern = new RegExp(
    `(?:${LABELS.join("|")})\\s*(?:is|:|=|-|–|—)?\\s*(?:\\*\\*|\\[|<b>|<strong>)?\\s*${CODE_TOKEN}`,
    "gi",
  );
  // And the reverse order: "481920 is your verification code".
  const reversePattern = new RegExp(`${CODE_TOKEN}\\s+is\\s+your\\s+(?:${LABELS.join("|")})`, "gi");

  for (const [source, haystack] of [
    ["subject", subject],
    ["text", text],
  ] as const) {
    for (const pattern of [labelPattern, reversePattern]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(haystack)) !== null) {
        const raw = match[1];
        const context = snippet(haystack, match.index, match[0].length);
        if (isFalsePositive(raw, true) || contextRejects(context, raw)) continue;
        add({
          code: raw.replace(/[\s-]/g, ""),
          kind: /^[0-9]+$/.test(raw.replace(/[\s-]/g, "")) ? "numeric" : "alphanumeric",
          // A label in the subject line is about as explicit as email gets.
          confidence: source === "subject" ? 0.95 : 0.9,
          method: "labelled",
          source,
          context,
        });
      }
    }
  }

  // ── Tier 2a: a code alone in the subject ──────────────────────────────────
  // "481920 is your code" is already caught above; this catches "Your code: —"
  // style subjects where the number stands by itself.
  const subjectCode = /(?:^|\s)([0-9]{4,8}|[A-Z0-9]{6,8})(?:\s|$)/g;
  let subjectMatch: RegExpExecArray | null;
  while ((subjectMatch = subjectCode.exec(subject)) !== null) {
    const raw = subjectMatch[1];
    if (isFalsePositive(raw)) continue;
    const context = snippet(subject, subjectMatch.index, raw.length);
    if (contextRejects(context, raw)) continue;
    add({
      code: raw,
      kind: /^[0-9]+$/.test(raw) ? "numeric" : "alphanumeric",
      confidence: 0.7,
      method: "subject",
      source: "subject",
      context,
    });
  }

  // ── Tier 2b: a code alone on its own line ─────────────────────────────────
  // The single most common layout in real verification email: the code sits on
  // a line by itself, usually in a big font, with nothing else around it.
  let offset = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const lineOffset = text.indexOf(line, offset);
    offset = lineOffset + line.length;
    if (!/^[A-Z0-9]{4,10}$|^[0-9]{3}[- ][0-9]{3}$/.test(trimmed)) continue;
    if (isFalsePositive(trimmed)) continue;
    add({
      code: trimmed.replace(/[\s-]/g, ""),
      kind: /^[0-9\s-]+$/.test(trimmed) ? "numeric" : "alphanumeric",
      confidence: 0.75,
      method: "isolated-line",
      source: "text",
      context: snippet(text, Math.max(0, lineOffset), trimmed.length),
    });
  }

  // ── Tier 3: magic links ───────────────────────────────────────────────────
  // Returned separately because following one is a different action from typing
  // a code, and an agent should decide deliberately which it is doing.
  const urlPattern = /https?:\/\/[^\s"'<>)\]]+/gi;
  let urlMatch: RegExpExecArray | null;
  const linkHaystack = `${text}\n${message.html ?? ""}`;
  while ((urlMatch = urlPattern.exec(linkHaystack)) !== null) {
    const url = urlMatch[0].replace(/[.,;:]+$/, "");
    if (!/verif|confirm|activate|magic|login|signin|sign-in|token=|code=|otp=|auth/i.test(url)) continue;
    if (/unsubscribe|preferences|privacy|terms/i.test(url)) continue;
    add({
      code: url,
      kind: "link",
      confidence: 0.8,
      method: "magic-link",
      source: "text",
      context: snippet(linkHaystack, urlMatch.index, url.length),
    });
  }

  // Rank: confidence first, then prefer codes over links, then shorter (a
  // 6-digit code beats a 10-digit id when both scored the same).
  return found.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if ((a.kind === "link") !== (b.kind === "link")) return a.kind === "link" ? 1 : -1;
    return a.code.length - b.code.length;
  });
}

/** The single best guess, or null when nothing survived the filters. */
export function bestCode(message: ExtractInput): ExtractedCode | null {
  const codes = extractCodes(message).filter((c) => c.kind !== "link");
  return codes[0] ?? null;
}
