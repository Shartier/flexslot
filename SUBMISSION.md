# FlexSlot — submission text and video script (draft)

Draft revised by Codex on 7 November 2026 (JST) from `impl-wait-1` (`9b212d3`) and the recorded reviews (`outputs/codex-prep/SUBMISSION_REVISED.md`), adopted here by Claude Code on the same day with the changes since then: the review fixes IR2-01, IR2-02 and IWAI-01, the Japanese screens and the current test count (Section 3). **Not published or submitted.** Section 1 is proposed Devpost copy; Section 2 is a recording plan; Section 3 is an internal release checklist. Update the final version and evidence before publication.

## 1. Proposed Devpost copy

### Project name and tagline

**FlexSlot** — Fill a fully booked slot through an agreed booking move, with PayPal payment and compensation by partial refund.

### Inspiration

A salon is fully booked at the only time a new customer can visit. An existing customer might be willing to move, but the shop needs a workable alternative, everyone's agreement, and a reliable way to handle the payment and compensation.

FlexSlot focuses on that one opportunity. The new customer pays the salon. The salon compensates the existing customer by partially refunding their original payment. The project connects scheduling, consent and payment recovery in one small workflow.

### What it does

The demo uses one fictional salon, one stylist, two services and one swap between an existing customer, A, and a new customer, B.

1. A has paid for a booking and registers acceptable alternative times in advance. Compensation is fixed at USD 10.00 in the demo.
2. B describes when they need an appointment. Gemini on Vertex AI turns free text into proposed conditions and asks for clarification when needed. Each customer checks and confirms their conditions.
3. Server code checks service duration, opening hours, available slots and the confirmed constraints. The shop sees either a feasible proposal or the reasons it cannot work.
4. The shop, A and B approve the specific terms. B then approves payment through PayPal Sandbox.
5. FlexSlot authorizes B's payment, rechecks the conditions, captures the payment and confirms both booking changes in one database transaction. It then requests the agreed partial refund against A's original captured payment.

The owner and the two customers have separate screens, in English or Japanese (a Japanese browser gets Japanese written for a salon booking service, not a machine translation). Booking status, B's payment and A's compensation have separate progress indicators. Mock and connected modes are labelled throughout. All PayPal payments in this project use **Sandbox test money**.

### Why compensation instead of a general discount?

A weekday discount can attract someone who has not booked yet. FlexSlot addresses a specific conflict after a slot is already booked: A can move, B cannot, and an eligible alternative slot is available. If a normal discount would produce the same outcome, FlexSlot does not assume it is better.

The owner sees an estimate, not a promise of profit. The sample is **USD 60.00 additional revenue − 10.00 compensation − 15.00 additional service cost − 2.50 payment-related costs − 12.00 opportunity cost = USD 20.50 estimated additional profit**. These are fictional assumptions; USD 2.50 is not a quoted PayPal fee. The opportunity cost represents the expected value of selling A's alternative slot to someone else. No measured salon results are claimed.

Compensation does not increase while a customer waits, and each booking can receive it once. These limits reduce some incentives to hold busy slots for compensation; they do not eliminate strategic behaviour or prove demand.

### How it is built

**PayPal is part of the core workflow.** Orders v2 and Payments v2 support approval, authorization, capture, partial refund, authorization void and a recovery refund to B if the booking cannot be committed after capture. A database transaction cannot atomically include PayPal, so each payment operation is recorded before dispatch, with its fixed input and request identifier. Recovery uses stored results, queries and, where appropriate, a retry of the same operation with the same request ID. Related order and capture queries help verify the recipient, amount and resource relationships before dependent steps continue. Verified webhooks prompt queries; their payloads do not directly settle a booking or payment.

**AI interprets free text.** The connected configuration uses `gemini-3.5-flash-lite` on Vertex AI with server-side Application Default Credentials. Structured output contains scheduling conditions and clarification questions, not payment amounts or approval commands. The person confirms the interpretation; program checks enforce payment terms, authority and availability. The model can still misunderstand a date or service, so a schema does not replace review of its answer. If AI is unavailable, the app explicitly offers manual entry instead of silently switching to mock AI.

**The app** uses TypeScript, Node.js 24, SQLite, React, Vite and zod. Data persists on the server. Separate role sessions, server-side party checks, CSRF protection and version-bound approvals restrict who can act on a proposal. This is a local demonstration, with no connection to a real salon's booking system.

### Challenges and what we verified

The hardest part was recovering from an uncertain payment result without treating a missing response as a failed payment. We separated obligations, attempts and API operations, and tested the boundaries around payment capture, the booking commit and compensation.

- One complete booking move was operated through the three screens using PayPal Sandbox and Vertex AI; database records matched subsequent Sandbox queries.
- Five Sandbox scenarios, R1–R5, exercised interruption and recovery. Response loss and refund rejection were injected, and booking conflicts were introduced deliberately; these were not PayPal outages. Process stops were actual exits. The observed final bookings and expected payment resources matched, without duplicate captures or refunds in those runs.
- R5 paused at four intermediate states. The three screens did not show the swap or compensation as completed at those pauses. A separate viewing server kept the payment workflow paused.
- Real Sandbox webhook deliveries were signature-verified and deduplicated, and a tampered copy was rejected.
- The recorded automated check has **369 tests**, using mock or fake external services and local HTTP relay tests. It is separate from the real Sandbox and Vertex checks.
- Phone-width and desktop-width browser emulation, and startup from a clean clone in another folder on the same PC, were checked. These are not physical-phone or different-PC tests.

### What we learned

Payment recovery depends on knowing which operation was intended, which result is confirmed and which result is still unknown. That distinction matters as much in customer-facing wording as it does in the database.

AI is useful for translating a customer's everyday language into conditions they can review. Approval, availability and money still need explicit rules and durable records.

Claude Code supported implementation and testing; Codex provided independent reviews and helped prepare submission materials. The creator defined the scope, performed account setup and approved Sandbox payments. These tools are development assistance, separate from the Vertex AI integration inside the app.

### What is next

The immediate work is to finish the remaining review fixes, test with a first-time user and a physical phone, and prepare reproducible judging access. Salon interviews have not been conducted, and demand is not validated. A future version could add this workflow to an existing booking system; that integration is outside this demo.

### Built with

TypeScript, Node.js, SQLite, React, Vite, zod, PayPal Orders v2, PayPal Payments v2, PayPal Webhooks, Google Cloud Vertex AI, Gemini.

## 2. Video plan — target 2:47

Use the real app with **Gemini on Vertex AI** and **PayPal Sandbox (test money)** labels visible for the main flow. Record the buyer's approval as the owner operates it. Keep passwords, secrets, account identifiers and invite tokens outside the recording. Show A's initial payment as already completed; do not imply the compensation is paid by B directly to A. The narration below is approximately 301 words, leaving room for pauses and visible actions within the planned 167 seconds.

Prepare the demo dates using the app's current sample text. Do not hard-code expired November dates into the recording. Waiting time may be shortened in editing if indicated, while preserving the actual order and results. Do not make a pending step appear completed with an edited overlay.

| Time | Actual screen or footage to show | English narration |
| --- | --- | --- |
| 0:00–0:14 | Owner booking table: A occupies the slot B needs | This salon is fully booked at the only time a new customer can visit. An existing customer could move. FlexSlot helps the shop turn that conflict into an agreed booking change. |
| 0:14–0:37 | A: original payment complete; enter move conditions; structure with Vertex; review and confirm | The existing customer has already paid. They register when they could move, for a fixed ten-dollar compensation. Gemini on Vertex AI turns their words into proposed conditions. The customer checks the dates and confirms them. Ambiguous conditions require clarification. |
| 0:37–0:57 | B: request; structure and confirm; show the eligible proposal | The new customer describes the time they need. Server code checks both people's conditions, service duration, opening hours and available slots. AI does not approve the swap or choose payment amounts. The result is a specific proposal the parties can review. |
| 0:57–1:21 | Owner: profit assumptions and terms; approve. A: agree to move | The shop reviews the terms and approves. The existing customer then agrees to move. Here, sixty dollars in additional revenue becomes twenty dollars and fifty cents in estimated profit after compensation, service costs, assumed fees and opportunity cost. This is a fictional calculation. |
| 1:21–1:51 | B: Accept and pay; actual Sandbox approval; return; show booking change and A's refund | The new customer approves payment with PayPal Sandbox, using test money. FlexSlot authorizes, rechecks and captures the payment. It changes both bookings in one database transaction, then requests the ten-dollar partial refund from the existing customer's original payment. The payment and refund have separate progress indicators. |
| 1:51–2:17 | Actual recovery evidence: paused state, then the completed result and anonymized operation counts | A lost response does not prove a payment failed. We tested process stops and injected lost responses on the Sandbox. Recovery used the saved operation records and request IDs. In the checked run, PayPal held one capture and one compensation refund. The paused screens did not claim completion. |
| 2:17–2:34 | Confirmed AI conditions, manual-entry option, connected-mode labels | AI helps interpret the request; people confirm the conditions, and code enforces the terms. If AI is unavailable, manual entry is clearly offered. Connected and mock modes are always labelled. |
| 2:34–2:47 | Final owner/A/B results; project name | The shop gains a booking. The existing customer receives compensation for moving. The new customer gets the time they need. That is FlexSlot. |

### Recording requirements

- The times are an editing plan, not a measured finished video. Record the narration and adjust pauses so the final export stays between 2:40 and 2:50, and strictly below 3:00.
- For the recovery section, use saved R5 images only if those images actually exist and the relevant text can be read. The written R5 record alone is not video footage. A recreated interruption must be labelled with its actual mode, such as “mock recreation; Sandbox results checked separately.” Obtain the owner's approval before any additional Sandbox payment needed for recording.
- Do not include a broad claim that prompt injection is impossible, that all failures are covered, or that the app has already produced real salon profit.
- Fix the cancellation-history and HOLD wording findings before filming those areas. Do not show a report's PASS alone as proof; show the relevant state and the checked resource counts.
- Before uploading, inspect the entire exported video, subtitles and visible URLs. Check that audio is understandable, the UI is legible, the actual duration is under three minutes and no sensitive values appear. Publication still requires the owner's confirmation.

## 3. Internal release checklist — not Devpost copy

### Evidence and remaining work

| Item | Current evidence or next action |
| --- | --- |
| Review basis | `impl-app-1-fix1` passed the second review. R1–R5 evidence is accepted for those scenarios. IR2-01, IR2-02 and IWAI-01 are fixed in `impl-wait-1-fix1` and wait for Codex's re-check. The Japanese screens (`d9416ee`) are not reviewed yet |
| Final copy | Update the reviewed tag, test count and limitations after fixes. Do not describe an earlier API run as a new run of the final code |
| Physical phone and first-time user | Still to be checked. Browser width emulation is useful but does not close these acceptance items |
| Recovery coverage | Pending refunds and query timeouts need the agreed focused check of status and recovery. State when a scenario uses a mock or injected fault; do not repeat Sandbox payments just to obtain a naturally pending result |
| Clean startup | Another folder on the same PC has been checked. Different-PC startup has not. Keep the exact English commands and prerequisites usable from the final public repository |
| Licence and repository | The source licence is undecided and the public repository has not been prepared for owner approval. Audit tracked files and history without printing secrets, add the chosen licence, then prepare the exact publishable revision |
| Judging access | Choose complete run instructions or a hosted demo. The README provides an account-free mock route and setup for connected modes; label their differences. Confirm how judges can evaluate the connected functionality without receiving the developer's private API keys |
| Images and icons | Design v2 (Codex): one photo-like image of a fictional salon (OpenAI's built-in image tool, 7 November 2026; the tool did not report the exact model or version, so none is claimed) and 18 code-drawn SVG icons. The earlier eight illustrations are not used in the app (the owner preferred less AI-looking, UI-first screens); `cover.webp` may still serve as a thumbnail base. The owner confirms their use in the public repository and the video before publishing (IMAGES.md) |
| Video | Narration/script only. No finished export, duration verification or public YouTube URL is claimed |
| Devpost | Registration, eligibility confirmation and final entry submission remain unverified. Do not treat this draft as an entry |

### Official submission requirements checked on 7 November

Provide public source with an open-source licence, English submission materials, a functional demo accessible through setup instructions or a hosted URL, and a public YouTube video shorter than three minutes. Maintain free judging access through the end of judging. The submission deadline is **13 November 2026, 05:00 JST**; judging ends **16 December 2026, 01:00 JST**. These times convert the official Pacific dates. Confirm the chosen access method and all public links before submission. [Official PayPal AI Hackathon rules](https://paypalaihackathon.devpost.com/rules)

Keep the internal targets of **9 November for feature freeze** and **11 November for submission**. Prioritize the review corrections and usability checks over adding more features. The owner approves the prepared repository, any deployment, the public video and the final entry before those actions occur. No API secrets or ADC files belong in public judging instructions.

Codex's review and questions 1–10: `outputs/codex-prep/IMPL_WAIT_1_REVIEW.md` (Codex's local file, not part of the public repository).
