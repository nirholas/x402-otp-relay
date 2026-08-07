# Expose x402-otp-relay as MCP tools

Three tools, and the middle one does the expensive thinking so the model doesn't have to.

## Install

```bash
npm install @modelcontextprotocol/sdk x402-fetch viem zod
```

## The server

`mcp-otp-relay.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

const BASE_URL = process.env.OTP_RELAY_URL ?? "http://localhost:4035";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const pay = wrapFetchWithPayment(fetch, account, 50_000n);   // ≤ $0.05 per call

const server = new McpServer({ name: "x402-otp-relay", version: "0.1.0" });

server.tool(
  "rent_mailbox",
  "Rent a disposable email mailbox for receiving a verification code ($0.01 USDC). " +
    "Returns relayAddress (PUBLIC — submit this to the signup form) and mailboxToken " +
    "(SECRET — never submit it anywhere; it is how you read the mailbox). " +
    "Mailboxes expire, so rent immediately before you need the address.",
  {
    label: z.string().optional().describe("Your own label for this mailbox, echoed back"),
    ttlSeconds: z.number().optional().describe("Requested lifetime in seconds. Ask for more if the form is slow."),
  },
  async (args) => {
    const res = await pay(`${BASE_URL}/mailbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    return { content: [{ type: "text", text: await res.text() }], isError: !res.ok };
  },
);

server.tool(
  "wait_for_code",
  "Wait for a verification email and return the extracted code. Polls the FREE metadata " +
    "endpoint internally until mail arrives, then pays $0.002 exactly once. " +
    "Prefer this over calling a poll tool repeatedly — that would cost 30x as much. " +
    "If the result has `links` but no `best`, the site sent a magic LINK rather than a code: " +
    "following it signs you in, which is a different action — tell the user rather than guessing.",
  {
    mailboxToken: z.string().describe("From rent_mailbox. Secret."),
    timeoutSeconds: z.number().default(60).describe("How long to wait for the mail"),
  },
  async ({ mailboxToken, timeoutSeconds }) => {
    // Free polling — this is the whole point of the tool.
    const deadline = Date.now() + timeoutSeconds * 1000;
    let arrived = false;
    while (Date.now() < deadline) {
      const meta = await fetch(`${BASE_URL}/messages/${mailboxToken}`);
      if (meta.status === 404) {
        return {
          content: [{ type: "text", text: "Mailbox expired or unknown. Rent a new one." }],
          isError: true,
        };
      }
      const { messageCount } = (await meta.json()) as { messageCount: number };
      if (messageCount > 0) { arrived = true; break; }
      await new Promise((r) => setTimeout(r, 1000));
    }

    // One paid call, whether or not the mail landed — the empty snapshot is
    // still useful (it distinguishes "not yet" from "wrong token").
    const res = await pay(`${BASE_URL}/codes/${mailboxToken}`);
    const body = (await res.json()) as {
      result: { payload: { best: { code: string } | null; codes: unknown[]; links: unknown[]; messages: unknown[] } };
    };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ mailArrived: arrived, ...body.result.payload }, null, 2),
        },
      ],
      isError: !res.ok,
    };
  },
);

server.tool(
  "release_mailbox",
  "Release a mailbox when finished. Free. Do this as soon as you have the code — " +
    "an unreleased mailbox is someone's verification code sitting on a server.",
  { mailboxToken: z.string() },
  async ({ mailboxToken }) => {
    const res = await fetch(`${BASE_URL}/mailbox/${mailboxToken}`, { method: "DELETE" });
    return { content: [{ type: "text", text: await res.text() }] };
  },
);

await server.connect(new StdioServerTransport());
```

## Claude Desktop config

```json
{
  "mcpServers": {
    "x402-otp-relay": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-otp-relay.ts"],
      "env": {
        "PRIVATE_KEY": "0xYourAgentWalletKey",
        "OTP_RELAY_URL": "http://localhost:4035"
      }
    }
  }
}
```

## Notes that matter in practice

- **Put the polling inside the tool.** A model given a "check for mail" tool will call it in a loop, and each call is $0.002. `wait_for_code` polls the free endpoint internally and pays once — $0.012 for a full verification instead of $0.06.
- **Say which value is secret, in the tool description.** Models will happily paste a token into a form field if nothing tells them not to. The description above is explicit for exactly that reason.
- **Handle magic links as a distinct outcome.** `links` non-empty with `best` null means there is no code to type. A model that pastes a URL into a 6-digit field wastes an attempt; one that follows the link without saying so has taken an action the user didn't ask for.
- **Surface the confidence.** Below 0.9, the `context` field is worth showing the user — "the email says `481920 is your verification code`" is checkable in a way that a bare number isn't.
- **Release in a finally block.** Codes shouldn't outlive the task.
- **Cap the wallet.** The third argument to `wrapFetchWithPayment` bounds any single call.
