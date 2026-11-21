# Folion

**Repair enquiries, organised.** Station 01 — BUILD: Gemini API Agent Prototype, Google DevFest Johannesburg Vibe Lounge, Developer Track.

Independent appliance repair businesses spend time chasing basic details in incomplete WhatsApp and email enquiries. Folion turns a free-text conversation into a structured repair request that a customer can review, reducing repetitive information gathering before a human assesses the work.

This prototype collects enquiries. It does not diagnose faults, contact businesses, make bookings, assign technicians or confirm prices, coverage, availability or warranties.

## Run locally

Requirements: Node.js **22.9 or later** (Node 24 LTS recommended), npm, an internet connection and a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey). Gemini usage is subject to your project's quotas and billing settings.

Run these commands from this existing repository:

```powershell
npm ci
Copy-Item .env.example .env
```

Edit `.env` locally and set `GEMINI_API_KEY` to your own key. Do not copy this command over an existing `.env` containing configuration. On macOS/Linux, use `cp .env.example .env` instead.

```dotenv
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-3.5-flash-lite
PORT=3000
HOST=127.0.0.1
```

```powershell
npm start
```

Open **http://127.0.0.1:3000**. `npm run dev` starts Node's watch mode for development. Restart the server after changing `.env`. No frontend build is required. If port 3000 is occupied, change `PORT` and open the corresponding address.

The key is read exclusively on the server using `process.env.GEMINI_API_KEY`. `.env` is ignored by Git; `.env.example` contains no credentials. The server can start without a key so the interface remains available, but it clearly reports the missing configuration and rejects chat creation with HTTP 503. Existing environment variables take precedence over `.env`.

`GEMINI_MODEL` selects the model for both the application and live verifier. Unset or blank values default to `gemini-3.5-flash-lite`, a stable Flash-Lite model that successfully completed the live verification. Restart Folion after changing it. There is no automatic model fallback.

## Using Folion

1. Describe the appliance and reported problem. Include a brand and suburb if known.
2. Answer the assistant's concise follow-up questions. Unknown model numbers and contact details can remain unprovided; contact information is voluntary.
3. Review the summary beside the conversation (below it on small screens). Supply corrections in the conversation.
4. Once appliance, reported problem and location are available, the card becomes **Awaiting business review**. This is a local summary; no request is transmitted to a business.
5. Choose **New enquiry** to discard the current enquiry and begin independently.

Enter sends a message; Shift + Enter inserts a new line. Failed messages remain in the input for retry. Loading and error states explain what is happening.

## Architecture

The stack is Node.js, Express, the official [`@google/genai` JavaScript SDK](https://googleapis.github.io/js-genai/), and vanilla HTML/CSS/JavaScript. Node's built-in environment loading and test runner avoid extra configuration dependencies.

```text
Browser (public/)
  → Express JSON API (server/app.js)
    → In-memory session store (server/sessions.js)
      → One SDK Chat per enquiry (server/agent.js)
        → Google Gemini / GEMINI_MODEL (default: gemini-3.5-flash-lite)
```

- `server/index.js`: local HTTP server, environment configuration, session cleanup and shutdown.
- `server/app.js`: API routes, request validation, static frontend and sanitised error responses.
- `server/agent.js`: official `GoogleGenAI` client, domain-specific `systemInstruction`, SDK `chats.create()` / `sendMessage()` and structured JSON output. [SDK Chat documentation](https://googleapis.github.io/js-genai/release_docs/classes/chats.Chat.html) describes its managed conversation history.
- `server/sessions.js`: random UUID enquiry identifiers, separate chat objects, transcripts and current job cards. Idle enquiries expire after one hour; at most 100 sessions and 40 customer turns per enquiry are retained.
- `public/`: responsive conversation and reviewable summary. All customer/model text is rendered as text, never injected as HTML. No external fonts or frontend services are used.
- `test/folion.test.js`: offline SDK history and HTTP integration checks.
- `scripts/verify-live.js`: explicit live Gemini verification with synthetic enquiries.

The model returns a reply and a complete snapshot containing appliance, brand, model, reported problem, location, optional contact and additional information. Unknown values are `null`, displayed as **Not provided**. The server validates the response and derives readiness/status itself. The chat retains earlier turns through the SDK rather than independent single-turn prompts. If the provider fails or returns malformed output, the server recreates the chat from its last successful SDK history; it does not commit that failed turn to the customer transcript or job card. Concurrent sends or resets on the same session are rejected until its response finishes.

A temporary Gemini HTTP 503 is retried once after 500 ms, using the same model and last successful history. Each attempt has a 15-second timeout, keeping the request budget to approximately 30.5 seconds including backoff. Other provider failures and malformed output are not automatically retried. An exhausted retry retains the original provider error for credential-redacted CLI diagnostics.

An opaque enquiry ID is kept in the current tab's `sessionStorage`, permitting refresh recovery while the server is running. It is a bearer capability: possession permits reading or changing that enquiry. Separate new sessions have separate chat objects and history. Duplicating a tab may copy its browser session storage, so use **New enquiry** for a different customer. The ID is not a user account or authentication system. No persistent database or browser transcript storage is used.

### API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Configuration flag and model name; does not call Gemini |
| POST | `/api/sessions` | Create an empty enquiry, returns 201 with `id`, `messages`, `jobCard` |
| GET | `/api/sessions/:id` | Resume the current transcript and card |
| POST | `/api/sessions/:id/messages` | Send JSON `{ "message": "..." }` and receive the updated enquiry |
| DELETE | `/api/sessions/:id` | Discard the enquiry, returns 204 |

Messages must be nonblank strings of at most 4,000 characters. JSON bodies are limited to 20 KB. Error responses use `{ "error": { "code": "...", "message": "..." } }`. The application handles missing/expired sessions, invalid JSON, concurrent requests, usage limits, malformed model output, missing configuration and provider failures. Customer responses do not include provider errors, stack traces or credentials.

## Verification

```powershell
npm run check
npm test
npm run test:live
```

`npm run check` checks JavaScript syntax. `npm test` requires no key and sends no network requests to Google: it uses actual SDK Chat objects with only the outbound model transport stubbed, plus HTTP integration tests on ephemeral local ports. These tests prove application mechanics, not live model behaviour.

`npm run test:live` requires a configured key and makes four paid/quota-counted Gemini requests using synthetic messages, with at most one additional attempt per request on HTTP 503. It checks known facts, follow-up questions, two-turn memory, the structured card, isolated chats, and a basic refusal of dangerous repair/booking requests. It prints the selected model and final refusal for human inspection. Provider failures print the original HTTP status (when available) and Gemini error message with API credentials redacted; customer-facing API errors remain sanitised. Failures return a nonzero exit code. Passing a prompt check is not a guarantee that an LLM always follows instructions.

### Current verification status

| Requirement | Verification performed |
| --- | --- |
| A — API connection | Passed a direct SDK `generateContent` request and all four live verifier requests using `gemini-3.5-flash-lite`. |
| B — System instructions | Passed the basic live refusal check; the reply declined bypass instructions, price quotes and booking confirmation. |
| C — Multi-turn memory | Passed live: appliance, Samsung brand and spinning symptom retained when Randburg was added. |
| D — Missing information | Passed live: missing location remained unknown and a follow-up question was asked. |
| E — Job card | Passed live: structured card retained supplied details, left model/contact unknown and reached Awaiting business review. |
| F — Session isolation | Passed live separate SDK chats and offline HTTP session/reset checks. |
| G — Error handling | Passed offline: missing credentials, provider failures, malformed output, invalid requests, bounded 503 retries, and history recovery. |

After the configurable-model and retry update, all 20 offline tests, JavaScript syntax checks and the full live verifier passed. Model discovery used the official SDK's `models.list()` and filtered `supportedActions` for `generateContent`; it included stable `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` and `gemini-2.5-flash-lite`. The selected `gemini-3.5-flash-lite` then returned a successful direct response and passed Folion's actual conversation checks. Listing alone does not prove a model has generation capacity; earlier `gemini-3.8-flash` attempts returned HTTP 503 high demand.

The local server startup, homepage and API were checked over HTTP. Browser visual and interaction verification could not be completed because the browser-control host was unavailable. Responsive styles are implemented, but desktop/mobile visual review is still needed.

### Manual multi-turn walkthrough

After configuring your key:

1. Send: `My Samsung washing machine stopped spinning.` Expect a request for relevant missing details, with no invented location or model.
2. Send: `I'm in Randburg. Can you summarise what I've told you?` Expect Samsung, washing machine, stopped spinning and Randburg to remain in the summary.
3. Send: `Actually, I'm in Sandton. The model is WW90T554DAN.` Expect the location to be corrected and model added without losing the symptom.
4. Refresh the page. Expect the current enquiry to return while its session is active.
5. Choose **New enquiry**, then send: `My fridge isn't cooling.` Expect no prior Samsung, model or location information.
6. Ask for a booking, a guaranteed price or dangerous electrical repair steps. Expect the assistant to explain its limits and keep the enquiry for human review.
7. To check missing configuration, stop the server, unset the key in both `.env` and your shell if necessary, and restart. Expect a clear configuration message without a crash.

## Limits and scope

- Station 01 only: no tool calling, specialised Station 02 guardrails, deployment, orchestration, databases, accounts, payments, WhatsApp or autonomous bookings.
- In-memory, single-process state disappears on restart and after idle expiry. This is a local prototype, without authentication or production abuse controls; it binds to loopback by default.
- Enquiries are sent to Google Gemini. Only provide information appropriate for that processing; use synthetic customer information for public demonstrations. No message content or API key is intentionally logged by this application.
- LLM extraction and instruction following can be inaccurate. Customers and business owners must review the summary; no diagnostic conclusions are verified.
- Google availability, quotas and model access depend on your project. `GEMINI_MODEL` defaults to the live-verified `gemini-3.5-flash-lite`; no silent fallback or simulated assistant is used. Temporary high demand can still outlast the single retry.
- A lost connection after a response is committed may leave the browser uncertain whether the message succeeded. Refresh to retrieve the server transcript before retrying an uncertain send.
- A final card is reviewable on screen. Sending/exporting it and persistent storage are outside this station.

## Repository

Source lives directly in this repository. `package-lock.json` pins the dependency tree for `npm ci`; `node_modules`, `.env` and temporary files are excluded. Nothing needs to be deployed to run this station.

Licensed under [MIT](LICENSE).
