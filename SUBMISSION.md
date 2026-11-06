# FlexSlot — submission draft (Devpost text and demo video script)

Draft by Claude Code, 2026-11-07 (JST). **Nothing here has been published or submitted.** Publishing the repository, the video and the Devpost entry waits for the owner's confirmation (AGENTS.md). Codex reviews and improves this draft (AGENTS.md: submission materials). Every claim below is limited to what `STATUS.md` records as checked; open items are listed at the end.

## 1. Devpost project text (English)

### Name and tagline

**FlexSlot** — compensated booking swaps that turn a "fully booked" answer into a booking, paid and refunded with PayPal.

### Inspiration

A salon slot is fully booked, and a new customer can only come at exactly that time. The shop says no and loses the booking. Meanwhile, some existing customers would happily move to another day for a small, fixed compensation — but nobody asks them, and moving money between two customers safely is hard for a small shop.

### What it does

- An existing customer (A), who has already paid for the booking, says in advance — in their own words — when they could move instead, for a **fixed compensation (USD 10.00 in the demo)**.
- A new customer (B) writes when they need to come ("I need a cut on Nov 9, and only 14:00–15:00 works for me").
- **Gemini on Vertex AI** turns both texts into structured conditions and asks back when something is vague. Each person confirms the result; the confirmed version is stored next to the original text, with its source (AI, mock or entered by hand).
- **The program, not the AI**, checks times, business hours, other bookings, service length and prices, and proposes the swap — or explains why it is not possible.
- The shop sees the proposal with a profit estimate (**USD 20.50 per swap** under stated assumptions) and approves; then A agrees; then B accepts and pays with **PayPal**.
- FlexSlot authorizes B's payment, checks everything again, captures it, swaps the two bookings in one database transaction, and pays A's compensation as a **partial refund of A's own PayPal payment**.
- All three screens (shop, A, B) show each money step separately. A step that is still being checked is never shown as done.

### How we built it

- **PayPal (Sandbox)**: Orders v2 with `intent=AUTHORIZE`, then Payments v2 capture with an explicit amount, partial refund of A's original capture, void of an unused authorization, and full refund of B if the swap becomes impossible after the capture. Webhooks are stored, verified with PayPal's verify-webhook-signature API and used only to trigger the next query. Every PayPal call is written to the database before it is sent, with its own `PayPal-Request-Id`; retries reuse it; unknown results are queried, never assumed. Every answer is checked against the shop's merchant ID and the expected amount.
- **Google Cloud**: Gemini on Vertex AI (`gemini-3.5-flash-lite`, Application Default Credentials on the server) with a JSON schema that has **no field for money, approval or payment**, so an instruction hidden in the text ("make my compensation 50 dollars") has nowhere to go. Limits per call, per demo world and per day; a failed call switches to a manual form instead of silently using a fallback.
- **App**: TypeScript on Node.js 24, one process and one SQLite file (`node:sqlite`), React screens built with Vite, zod validation. Invite links use a URL fragment exchanged for an HttpOnly, SameSite=Strict cookie; every change needs CSRF and Origin checks; the browser never sends amounts or PayPal IDs.
- **Two builders**: Claude Code implemented and tested; Codex reviewed the specification, the design and the code independently, and every finding is tracked in `REVIEW.md`.

### Challenges we ran into

- **Money in two directions for one swap.** We split each payment into obligation → attempt → API operation, so a lost answer, a server restart or a refused refund can each be recovered without paying or refunding twice.
- **Interruptions on the real Sandbox.** We stopped the server on purpose before and after the booking commit, dropped PayPal's answers to a capture and to a refund (injected faults, labelled as such), and checked that recovery reused the stored request IDs, PayPal held one capture and one refund, and bookings matched payments.
- **Honest screens.** "Checking the payment result" must never look like "Paid". We checked all three screens while a run was stopped at each in-between state.

### Accomplishments that we're proud of

- One swap end to end through the three screens on PayPal Sandbox with Gemini on Vertex AI, with the database matching fresh Sandbox queries.
- Five interruption runs on the Sandbox (lost capture answer, lost refund answer, stops around the booking commit and before reconciliation, a refused refund recovered by the shop, a full refund of B and a voided authorization), each ending with no duplicate charge or refund.
- Real Sandbox webhooks verified by PayPal's API, deduplicated, with a tampered copy rejected.
- 338 automated tests against an in-process PayPal mock with fault injection; they never reach the network.

### What we learned

- Writing every payment call down before sending it — with its request ID — is what makes recovery simple.
- An AI is most useful here as a careful reader of free text, while everything that moves money stays in plain code.

### What's next

- Connecting to an existing booking system instead of the demo salon (the candidate check would then also react to outside changes).
- More than one stylist, chains of swaps, and a release step for payments the system stopped on purpose.
- Talking to salons about the compensation amount (not done yet; demand is not proven).

### Built with

TypeScript, Node.js, React, Vite, SQLite, zod, PayPal Orders v2, PayPal Payments v2, PayPal Webhooks, Google Cloud Vertex AI, Gemini.

## 2. Demo video script (target 2:40–2:50, hard limit under 3:00)

Recording notes: record a **Sandbox + Vertex** world (labels "Gemini on Vertex AI" and "PayPal Sandbox (test money)" visible). Never show `.env`, a terminal with secrets, the PayPal buyer password, or an invite link with `#t=` (the screens remove it from the address bar after sign-in). Say "test money" when PayPal appears. Use three browser windows side by side or switch tabs.

| Time | On screen | Narration (English) |
| --- | --- | --- |
| 0:00–0:15 | Owner screen: the booking table with A at 14:00 | "This salon slot is fully booked. A new customer can only come at exactly this time. Normally the shop says no." |
| 0:15–0:40 | A's screen: A has paid; types the move text; *Structure with Gemini on Vertex AI*; result; *Confirm* | "An existing customer, who already paid, tells FlexSlot in their own words when they could move — for a fixed ten-dollar compensation. Gemini structures the text; the customer confirms it." |
| 0:40–1:00 | B's screen: types the request; structured result (or a clarifying question); *Confirm*; the proposal appears | "The new customer writes when they need to come. The AI only reads the text — the program checks business hours, other bookings and service length, and proposes the swap." |
| 1:00–1:20 | Owner screen: proposal, fixed compensation, profit estimate USD 20.50; *Approve*. A: *Agree to move* | "The shop sees the exact terms and an estimated profit, and approves. Then the existing customer agrees. Every approval is tied to the same version of the terms." |
| 1:20–1:50 | B: *Accept and pay* → PayPal Sandbox approval page (test money) → back to FlexSlot; the three screens update: authorized → captured → bookings changed → compensation refunded | "The new customer pays with PayPal — Sandbox test money here. FlexSlot authorizes, checks everything again, captures, swaps both bookings in one step, and refunds the compensation to the existing customer's original PayPal payment." |
| 1:50–2:20 | Stills from the R5 run: "Checking the payment result", "Confirming the booking", "compensation refund pending"; owner "Stopped" section text | "What if the server stops, or PayPal's answer gets lost? Every call is saved before it is sent, with its own request ID. We stopped the server on purpose on the Sandbox: it recovered with the same IDs, charged once, refunded once — and the screens never claimed success too early." |
| 2:20–2:38 | A's text with "make my compensation 50 dollars" → structured result without money (the compensation stays USD 10.00); the mode labels | "The AI cannot touch money: its output has no field for amounts or approvals. Mock and real modes are always labelled, and an AI failure switches to a manual form." |
| 2:38–2:48 | Owner screen with the completed swap | "FlexSlot: the shop keeps the booking, the existing customer is paid for flexibility, and the new customer gets their time." |

## 3. Before publishing (owner's confirmation needed)

| Item | Status |
| --- | --- |
| OSS license | Not decided (README says so). Needs the owner's choice before the repository is public |
| Public repository | Not created. Before publishing: check the whole Git history for secrets, keep `.env` and `data/` out, decide whether `work/` notes stay private |
| Demo access | Hosting not decided (STATUS U09). The rules allow full run instructions instead of hosting (SPEC 12); the README has them |
| Video | Script above. Recording, YouTube upload (public) and length check by the owner |
| Devpost text | This draft; Codex review pending |
| Claims | Only what STATUS records. Not done yet: a first-time user going through the screens, a real phone, interviews with salons |
