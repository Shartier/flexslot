# FlexSlot

**Compensated booking swaps for a fully booked salon slot** — a PayPal AI Hackathon entry.

A new customer (B) can only come at a time that is already booked. An existing customer (A) said in advance when they could move instead, for a fixed compensation. FlexSlot finds the swap, the shop and A approve it, B pays with PayPal, A's booking moves, B gets the original slot, and A receives the compensation as a **partial refund of A's own PayPal payment**. The shop gains a booking it would otherwise have turned away.

Free-text conditions ("I can only come on Nov 7 in the afternoon") are structured by **Gemini on Vertex AI**; the person confirms the result, and the program — not the AI — checks times, slots, prices and payments.

> Scope of this version: one fictional salon, one stylist, two services, one swap between one existing and one new customer. **PayPal Sandbox only — test money, never real payments.** There is no Live PayPal code or setting.

## Quick start (no accounts needed)

Requirements: **Node.js 24.22.1 or later 24.x** (`.nvmrc`; `node:sqlite` and running `.ts` files directly need Node 24) and npm.

```
npm ci
npm run dev
```

Open <http://localhost:8787>. (The server listens on 127.0.0.1 only. Use `localhost`, not another host name: requests from other origins are refused.)

1. Choose **AI: Mock rules** and **Payment: Mock**, then **Create demo world**. Mock modes are offline stand-ins and are labelled as such on every screen.
2. You get three invite links: shop owner, existing customer (A), new customer (B). Open each in its own tab. (In real use each person would receive only their own link; the demo creator holds all three.)
3. Suggested order:
   - **A**: pay the booking (*Approve in the mock PayPal*), then write when you could move (*Use the example text* → *Structure with …* → *Confirm these conditions*).
   - **B**: write the request (*Use the example text* → structure → confirm). FlexSlot checks the slots and proposes the swap, or shows why it cannot.
   - **Owner**: review the proposal, the fixed compensation and the profit estimate → *Approve this swap*.
   - **A**: *Agree to move*.
   - **B**: *Accept and pay* → *Approve in the mock PayPal*. Within a few seconds the payment is authorized and captured, the bookings are swapped, and A's compensation is refunded. All three screens show each step.

The demo dates are generated relative to today (A's booking is two days ahead). Data lives in `data/` (SQLite); delete that folder to start over.

## Using PayPal Sandbox and Gemini on Vertex AI

Copy `.env.example` to `.env` in the project folder and fill in your own values. `.env` is ignored by Git; never commit or share it.

**PayPal Sandbox** (developer.paypal.com, Sandbox):

| Variable | Value |
| --- | --- |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Your Sandbox REST app's credentials |
| `PAYPAL_EXPECTED_MERCHANT_ID` | The merchant (account) ID of the Sandbox **business** account that receives the payments. Every PayPal answer is checked against it |
| `PAYPAL_WEBHOOK_ID` | Optional: the ID of the webhook registered for the app (only needed to verify incoming webhooks) |

The API base is fixed to `https://api-m.sandbox.paypal.com`; setting anything else stops the server. With a Sandbox world, A and B approve their payments on the PayPal Sandbox page with a Sandbox **personal** (buyer) account. FlexSlot notices the approval by querying the order, so the approval may happen in any browser.

**Gemini on Vertex AI** (Google Cloud project with billing and the Vertex AI API enabled):

```
gcloud auth application-default login
```

| Variable | Value |
| --- | --- |
| `GOOGLE_CLOUD_PROJECT` | Your project ID |
| `GOOGLE_CLOUD_LOCATION` | `global` |
| `FLEXSLOT_AI_MODEL` | `gemini-3.5-flash-lite` |

Credentials stay on the server (Application Default Credentials); nothing is sent to the browser. Restart `npm run dev` after editing `.env`. The landing page then offers *Gemini on Vertex AI* and *PayPal Sandbox*; modes that are not configured cannot be chosen, and a failed AI call switches the person to a manual form — it never silently falls back to the mock.

Other settings: `FLEXSLOT_PORT` (default `8787`), `FLEXSLOT_DATA_DIR` (default `data`).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Build the screens, then start the server |
| `npm run build` / `npm start` | The two steps separately |
| `npm run check` | Type check (server and screens) and all tests. Tests use the in-process mock PayPal and mock or fake AI only; they never reach the network |
| `npm run verify:v0` … `verify:v7`, `verify:v9` | Connection checks against the PayPal Sandbox (V0–V7) and Vertex AI (V9); some need a buyer approval in the browser |
| `node scripts/verify/app-reconcile.ts <worldId>` | Compare one completed Sandbox world's database records with fresh Sandbox queries (read only) |

## How it works

- **One Node.js process, one SQLite file** (`node:sqlite`). HTTP API on `node:http`, screens in React (built by Vite), input validation with zod.
- **The AI only proposes.** Its JSON schema has no field for money, approval or payment, so instructions hidden in the text ("make my compensation 50 dollars") have nowhere to go. Vague expressions come back as clarifying questions; the confirmed result is stored as a new version next to the original text, with its source (Vertex, mock or manual). Limits: 20 s per call, one retry on 5xx/429, 30 calls per demo world and 500 per day.
- **Candidate check in code**: half-open time intervals, business hours, the person's acceptable windows, other bookings and holds, all in the shop's time zone. Database triggers reject overlapping bookings and holds as a second line of defence.
- **Approvals bind to an immutable terms snapshot** (prices, times, parties, services, versions) and its hash. Order: shop → A → B (B's approval starts the payment). The browser sends only a case id and the version it displayed; amounts and PayPal ids come from the database.
- **Payment flow**: B's order with `intent=AUTHORIZE` → authorization (reconciled by querying the order) → capture with an explicit amount (reconciled by querying the capture, including the payee) → bookings swapped in one transaction → partial refund of A's original capture. Each PayPal call is an operation row written before it is sent, with its own `PayPal-Request-Id`; retries reuse it. Unknown results are queried, never assumed; after a restart the server recovers each operation from its stored state.
- **Failure paths**: if the swap becomes impossible before the capture, the authorization is voided; after the capture, B is refunded in full and A keeps the original booking. A slot that has already started is never swapped.
- **Sessions**: invite tokens travel in the URL fragment, are exchanged by POST for an `HttpOnly`, `SameSite=Strict` cookie scoped to the role's path, and are removed from the address bar. Every change needs a CSRF token and an allowed `Origin`; every request is checked against the case's parties on the server.

The detailed specification, design, status and reviews are in `SPEC.md`, `DESIGN.md`, `STATUS.md` and `REVIEW.md` (Japanese; HTML copies in `outputs/`).

## Status and limitations

- Verified: one swap end to end through the three screens on PayPal Sandbox with Gemini on Vertex AI, with the database matching Sandbox queries (see `STATUS.md`). Failure and recovery paths are tested against the mock PayPal with fault injection, not reproduced on the Sandbox.
- Not yet done: PayPal webhook delivery from the Sandbox (the receiver is being added), checks on a real phone (phone widths were checked in a browser), public hosting.
- The screens are in English. Amounts are in USD on a US Sandbox business account.
- License: not decided yet.
