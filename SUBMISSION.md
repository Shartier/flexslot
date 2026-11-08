# FlexSlot — submission description and verification

Updated 8 November 2026 (JST). The [source repository](https://github.com/Shartier/flexslot) is public under Apache-2.0, and the [2:17 English demo video](https://youtu.be/S93QUPCj82o) is public. **The Devpost entry has not yet been submitted.** The application code used for the recording and initial public release is `bc90a5388b09ca931c7c731582f61f20d46afffc`; the later changes described here update submission documents only.

Section 1 contains the current English submission description so it can be read directly from this public repository. Section 2 preserves the earlier recording plan, clearly marked as superseded. Section 3 records the evidence and remaining actions. Additional local working files are not required to run or assess the project.

## 1. Devpost submission text

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

The owner and the two customers have separate screens, in English or Japanese. Booking status, B's payment and A's compensation have separate progress indicators. Mock and connected modes are labelled throughout. All PayPal payments in this project use **Sandbox test money**.

### Why compensation instead of a general discount?

A weekday discount can attract someone who has not booked yet. FlexSlot addresses a specific conflict after a slot is already booked: A can move, B cannot, and an eligible alternative slot is available. If a normal discount would produce the same outcome, FlexSlot does not assume it is better.

The owner sees an estimate, not a promise of profit. The sample is **USD 60.00 additional revenue − 10.00 compensation − 15.00 additional service cost − 2.50 payment-related costs − 12.00 opportunity cost = USD 20.50 estimated additional profit**. These are fictional assumptions; USD 2.50 is not a quoted PayPal fee. The opportunity cost represents the expected value of selling A's alternative slot to someone else. No measured salon results are claimed.

Compensation does not increase while a customer waits, and each booking can receive it once. These limits reduce some incentives to hold busy slots for compensation; they do not eliminate strategic behaviour or prove demand.

### Design decisions

- **Money always flows between a customer and the shop.** B pays the shop the normal price; the shop refunds a fixed part of A's own original payment. Customers never pay each other, which avoids person-to-person money transfer and keeps one merchant responsible for every payment and refund.
- **A opts in before anyone asks.** A registers when they could move, and the fixed compensation is set at that moment. Only people who agreed in advance are ever asked, the program can check a swap at once, and nobody negotiates the amount.
- **One existing customer is asked at a time.** This demo handles one matching A and one B. Multiple-customer chains and competing offers are outside its scope.
- **B pays last.** The shop approves, then A agrees, then B approves the payment. FlexSlot authorizes first, checks the terms again, and only then captures; if the check fails, it releases the authorization instead of charging.

### How it is built

**PayPal is part of the core workflow.** Orders v2 and Payments v2 support approval, authorization, capture, partial refund, authorization void and a recovery refund to B if the booking cannot be committed after capture. A database transaction cannot atomically include PayPal, so each payment operation is recorded before dispatch, with its fixed input and request identifier. Recovery uses stored results, queries and, where appropriate, a retry of the same operation with the same request ID. Related order and capture queries help verify the recipient, amount and resource relationships before dependent steps continue. Verified webhooks prompt queries; their payloads do not directly settle a booking or payment.

**AI interprets free text.** The connected configuration uses `gemini-3.5-flash-lite` on Vertex AI with server-side Application Default Credentials. Structured output contains scheduling conditions and clarification questions, not payment amounts or approval commands. The person confirms the interpretation; program checks enforce payment terms, authority and availability. The model can still misunderstand a date or service, so a schema does not replace review of its answer. If AI is unavailable, the app explicitly offers manual entry instead of silently switching to mock AI.

**The app** uses TypeScript, Node.js 24, SQLite, React, Vite and zod. Data persists on the server. Separate role sessions, server-side party checks, CSRF protection and version-bound approvals restrict who can act on a proposal. This is a local demonstration, with no connection to a real salon's booking system.

### Challenges and what we verified

The hardest part was recovering from an uncertain payment result without treating a missing response as a failed payment. We separated obligations, attempts and API operations, and tested the boundaries around payment capture, the booking commit and compensation.

- The final 2:17 English video records a new complete booking move using PayPal Sandbox and Vertex AI, at the same commit as the published source. A and B each approved a USD 60 Sandbox payment; A received a USD 10 partial refund against A's original capture. Both real Vertex requests succeeded. A read-only reconciliation of the database and fresh Sandbox queries passed all 21 checks.
- Five Sandbox scenarios, R1–R5, exercised interruption and recovery. Response loss and refund rejection were injected, and booking conflicts were introduced deliberately; these were not PayPal outages. Process stops were actual exits. The observed final bookings and expected payment resources matched, without duplicate captures or refunds in those runs.
- The earlier R5 scenario paused at four intermediate states. The three screens did not show the swap or compensation as completed at those pauses. A separate viewing server kept the payment workflow paused. Its stored final reconciliation report passed 14 checks. This earlier scenario used mock AI and is shown in the video as a labelled evidence summary, separate from the new real Vertex demonstration.
- Real Sandbox webhook deliveries were signature-verified and deduplicated, and a tampered copy was rejected.
- The most recent recorded automated check passed **402 tests**, including the public-mode boundary checks, using mock or fake external services and local HTTP relay tests. That check predates this submission packaging; it was not rerun for the video. It is separate from the real Sandbox and Vertex checks.
- Phone-width and desktop-width browser emulation, and startup from a clean clone in another folder on the same PC, were checked. These are not physical-phone or different-PC tests.

### What we learned

Payment recovery depends on knowing which operation was intended, which result is confirmed and which result is still unknown. That distinction matters as much in customer-facing wording as it does in the database.

AI is useful for translating a customer's everyday language into conditions they can review. Approval, availability and money still need explicit rules and durable records.

Claude Code supported implementation and testing; Codex provided independent reviews and helped prepare submission materials. The creator defined the scope, performed account setup and approved Sandbox payments. These tools are development assistance, separate from the Vertex AI integration inside the app.

### What is next

The next steps are first-time usability testing, physical-phone testing and short salon interviews. Demand and real business outcomes have not been validated. A future version could add this consent-and-payment workflow to an existing booking system; that integration is outside this demo. The submitted scope keeps compensation fixed and handles one swap between one existing customer and one new customer.

### Built with

TypeScript, Node.js, SQLite, React, Vite, zod, PayPal Orders v2, PayPal Payments v2, PayPal Webhooks, Google Cloud Vertex AI, Gemini.

### How judges can try it

Public demo video: [Watch FlexSlot on YouTube](https://youtu.be/S93QUPCj82o).

Public source and README: [Shartier/flexslot](https://github.com/Shartier/flexslot).

No hosted service is provided. The public source repository includes the complete English README and an account-free local demo. Install Node.js 24.22.1 or a later 24.x release, download or clone the repository, open its folder in a terminal, run `npm ci` and `npm run dev`, then open `http://localhost:8787`. With no `.env`, choose the mock AI and mock payment modes and follow the README through all three screens. These modes do not call PayPal or Google. The completed English video demonstrates real PayPal Sandbox and Vertex AI operation with test money. Login and waiting time are omitted, and retained screen footage and narration play at normal speed; the README also explains how to configure those integrations with your own credentials.

### Demo and asset disclosures

The video is 2 minutes 17 seconds, with English screens, English narration and burned-in English subtitles. Historical recovery evidence is labelled separately from the recorded transaction. All salon names, customers, costs and business results are fictional. Salon images are AI-generated. English narration was generated with HeyGen Voice (Annie - Lifelike; returned engine: Orca). Third-party notices and image provenance are included in the source repository.

## 2. Video plan — target 2:47 (superseded by the published 2:17 video)

The published video (<https://youtu.be/S93QUPCj82o>, 2 minutes 17 seconds) uses an approved 355-word shortened narration, English screens, English narration voices and burned-in English captions. It was recorded on the same source as the public `main` with a fresh database: the owner approved A's original USD 60 payment and B's new USD 60 payment on PayPal Sandbox, A received a USD 10 partial refund, and both Vertex AI calls succeeded. A new read-only reconciliation of the database against Sandbox queries passed all 21 items. The earlier R5 interruption run (mock AI, injected response loss after real PayPal responses) appears only as a summary card labelled as a past test. The plan below is kept as the record of what was prepared.

Use the real app with **Gemini on Vertex AI** and **PayPal Sandbox (test money)** labels visible for the main flow. Record the buyer's approval as the owner operates it. Keep passwords, secrets, account identifiers and invite tokens outside the recording. Show A's initial payment as already completed; do not imply the compensation is paid by B directly to A. The narration below is approximately 301 words, leaving room for pauses and visible actions within the planned 167 seconds.

Prepare the demo dates using the app's current sample text. Do not hard-code expired November dates into the recording. Waiting time may be shortened in editing if indicated, while preserving the actual order and results. Do not make a pending step appear completed with an edited overlay.

| Time | Actual screen or footage to show | English narration |
| --- | --- | --- |
| 0:00–0:14 | Owner booking table: A occupies the slot B needs | This salon is fully booked at the only time a new customer can visit. An existing customer could move. FlexSlot helps the shop turn that conflict into an agreed booking change. |
| 0:14–0:37 | A: original payment complete; enter move conditions; structure with Vertex; review and confirm | The existing customer has already paid. They register when they could move, for a fixed ten-dollar compensation. Gemini on Vertex AI turns their words into proposed conditions. The customer checks the dates and confirms them. Ambiguous conditions require clarification. |
| 0:37–0:57 | B: request; structure and confirm; show the eligible proposal | The new customer describes the time they need. Server code checks both people's conditions, service duration, opening hours and available slots. AI does not approve the swap or choose payment amounts. The result is a specific proposal the parties can review. |
| 0:57–1:21 | Owner: profit assumptions and terms; approve. A: agree to move | The shop reviews the terms and approves. The existing customer then agrees to move. Here, sixty dollars in additional revenue becomes twenty dollars and fifty cents in estimated profit after compensation, service costs, assumed fees and opportunity cost. This is a fictional calculation. |
| 1:21–1:51 | B: *Pay USD 60.00*; actual Sandbox approval; return; show the “Booked” seal, the booking change and A's refund | The new customer approves payment with PayPal Sandbox, using test money. FlexSlot authorizes, rechecks and captures the payment. It changes both bookings in one database transaction, then requests the ten-dollar partial refund from the existing customer's original payment. The payment and refund have separate progress indicators. |
| 1:51–2:17 | Actual recovery evidence: paused state, then the completed result and anonymized operation counts | A lost response does not prove a payment failed. We tested process stops and injected lost responses on the Sandbox. Recovery used the saved operation records and request IDs. In the checked run, PayPal held one capture and one compensation refund. The paused screens did not claim completion. |
| 2:17–2:34 | Confirmed AI conditions, manual-entry option, connected-mode labels | AI helps interpret the request; people confirm the conditions, and code enforces the terms. If AI is unavailable, manual entry is clearly offered. Connected and mock modes are always labelled. |
| 2:34–2:47 | Final owner/A/B results (completion cards with seals); project name | The shop gains a booking. The existing customer receives compensation for moving. The new customer gets the time they need. That is FlexSlot. |

### Recording requirements

- The times are an editing plan, not a measured finished video. Record the narration and adjust pauses so the final export stays between 2:40 and 2:50, and strictly below 3:00.
- For the recovery section, use saved R5 images only if those images actually exist and the relevant text can be read. The written R5 record alone is not video footage. A recreated interruption must be labelled with its actual mode, such as “mock recreation; Sandbox results checked separately.” Obtain the owner's approval before any additional Sandbox payment needed for recording.
- Do not include a broad claim that prompt injection is impossible, that all failures are covered, or that the app has already produced real salon profit.
- The cancellation-history and HOLD wording findings were fixed in `impl-wait-1-fix1` (IR2-01, IR2-02, IWAI-01). Do not show a report's PASS alone as proof; show the relevant state and the checked resource counts.
- Before uploading, inspect the entire exported video, subtitles and visible URLs. Check that audio is understandable, the UI is legible, the actual duration is under three minutes and no sensitive values appear. Publication still requires the owner's confirmation.

## 3. Internal release checklist — not Devpost copy

### Evidence and remaining work

| Item | Current evidence or next action |
| --- | --- |
| Review basis | Codex rechecked `impl-final-2` (`1a235cfc263250d5e56afbf9a3572125a1e0fe03`) on 7 November 2026: 390 tests passed, the browser prevented a second POST while state refresh was pending, the mock flow completed, and shipped licence texts matched. FR1-01 and FR1-02 are closed; the remaining FR1-03 editorial wording was aligned in this documentation update. This was not a new Sandbox or Vertex run. Earlier R1–R5 evidence applies to those recorded scenarios |
| Final copy | Section 1 is aligned with the completed recording and published video. The new recorded transaction passed 21 read-only reconciliation checks. The earlier 402-test automated result is recorded separately; it was not rerun for these documentation updates |
| Physical phone and first-time user | The owner chose to judge the final design on a PC screen; phone widths were checked in a browser only. A first-time user has not tried the final screens yet |
| Recovery coverage | PENDING captures and refunds and query timeouts are checked with the mock and injected faults (`tests/app-pending.test.ts`): no screen shows them as completed, no new capture or refund is created, and the case completes once. A naturally pending result on the Sandbox has not been observed; do not repeat Sandbox payments just to obtain one |
| Clean startup | Another folder on the same PC has been checked. Different-PC startup has not. Keep the exact English commands and prerequisites usable from the final public repository |
| Licence and repository | Apache License 2.0 (the owner's choice): `LICENSE`, `package.json`, README and THIRD_PARTY_NOTICES.md. The screens' build ships the project licence and the unchanged licences of React, React DOM, Scheduler and the four fonts at `/assets/licenses/` (linked from every screen's footer). The owner approved the initial source publication on 7 November. Its 165 files were anonymously retrieved and compared with the approved revision. Limited history screening reported no matches for the credential values and formats checked; this is not an exhaustive security guarantee |
| Judging access | The owner decided to forgo a hosted URL. Provide the public repository and complete English local setup/run instructions, including an account-free mock flow. The published video demonstrates real Sandbox and Vertex operation; connected-mode setup uses the tester's own credentials. Never publish the developer's private keys. Hosting support remains unused and is not a submission requirement |
| Images and icons | 18 code-drawn SVG icons. Earlier images (eight illustrations, the design-v2 photo) are no longer used in the app. Codex's v4 `cover.webp` (16:9) can serve as the Devpost and video thumbnail base. The published source and video use the v4 salon imagery. Provenance and the reported model/version limits are documented in IMAGES.md and THIRD_PARTY_NOTICES.md |
| Design and fonts | The screens follow the crafted mockup v4 with a terracotta accent (owner's choice, 7 November 2026). Photos and the paper texture: Codex's v4 set (six images in the app plus an optional cover; OpenAI's built-in image tool, 7 November 2026; the tool did not report the model or version, so none is claimed); the screens say the photos are AI-generated and not a real business. Fonts are bundled from @fontsource and served from the app's own origin: Shippori Mincho, Zen Kaku Gothic New, Inter and Cormorant Garamond, all under the SIL Open Font License 1.1 (listed in THIRD_PARTY_NOTICES.md). Seals, the logo, the progress line and the profit bar are drawn in code |
| Video | Published by the owner: <https://youtu.be/S93QUPCj82o>, 2:17 (under three minutes). Codex checked anonymously that it is public (not private, not unlisted) and plays without signing in; a full listening check and a byte comparison after YouTube's re-encoding were not done. The check covered public visibility, title, duration, description and sampled playback. Local evidence records were retained by the creator |
| Devpost | Not submitted. Next: copy Section 1, the public source URL and the public video URL into the Devpost form, and the owner confirms registration, eligibility, team details and the final entry before submitting (target 11 November; deadline 13 November 05:00 JST) |

### Official submission requirements checked on 8 November

Provide public source with an open-source licence, English submission materials, a functional demo accessible through setup instructions or a hosted URL, and a public YouTube video shorter than three minutes. Maintain free judging access through the end of judging. The submission deadline is **13 November 2026, 05:00 JST**; judging ends **16 December 2026, 01:00 JST**. These times convert the official Pacific dates. Confirm the chosen access method and all public links before submission. [Official PayPal AI Hackathon rules](https://paypalaihackathon.devpost.com/rules)

Keep the internal targets of **9 November for feature freeze** and **11 November for submission**. Prioritize the review corrections and usability checks over adding more features. The owner approves the prepared repository, any deployment, the public video and the final entry before those actions occur. No API secrets or ADC files belong in public judging instructions.

Codex's review and questions 1–10: `outputs/codex-prep/IMPL_WAIT_1_REVIEW.md` (Codex's local file, not part of the public repository).
