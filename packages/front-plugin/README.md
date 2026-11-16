# Overturn for Front

QA for AI-drafted replies, in the conversation sidebar. It watches the composer for the AI draft, diffs it against what the teammate actually sends, asks for a one-line reason, and posts the result to `POST /v1/capture`. The draft becomes a recorded run, the difference becomes a case, and the suite replays it against any model before the next prompt or model change. The drafting agent never has to be instrumented, and it does not matter who wrote the draft: a Front AI assist, a macro, a pasted reply or a recorded SDK run. The support lead gets the untouched rate and the fixes by reason, by team and by week, on the Capture page.

## What the agent sees

A small panel in the conversation sidebar:

- **Draft inserted · 112 words** once an AI assist, macro or paste lands in the composer (anything reply-sized inserted in one go). If the drafting agent recorded its run with the Overturn SDK (`externalId: "fr:<conversation id>"`), the draft is taken from that run instead. "Use the current text as the draft" marks it by hand.
- A **reason** box with quick picks from the installed pack (`support` by default, or `claims`).
- On **Send**: sent as drafted → an `approve` capture, no prompt; changed → an `edit` capture with the reason as the case's title and the judge's rubric. With *require a reason* on, a changed reply is held in the panel until a reason is picked.

Front's Plugin SDK has no pre-send hook (unlike Zendesk's `ticket.save`). The plugin never vetoes Front's own Send. `require_reason` holds the **capture**, not the send; a failed capture logs in the panel and gets out of the way.

The conversation is read only after a draft is known. A thread with no draft is never listed.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build: `pnpm --filter @overturn-ai/front-plugin build` → `dist/overturn-front-plugin.zip` (and `dist/app/` to host).
3. Host the plugin. The recommended path is the small proxy in `scripts/proxy.mjs`, which serves `dist/app` and attaches the project key **server-side** so it never sits in the iframe, the plugin URL, history or `Referer`:

   ```bash
   OVERTURN_API_KEY=ov_live_… OVERTURN_BASE_URL=https://api.overturn.run \
     node packages/front-plugin/scripts/proxy.mjs --root packages/front-plugin/dist/app --port 8787
   ```

   Point Front (Settings → Company → Developers → your app → Side panel URL) at that origin, for example `https://overturn-front.example/`.

4. If you host the `dist/app` folder as static files instead, the teammate pastes the project key in **Plugin settings** (stored in `localStorage` on that origin). Do not put `overturn_api_key` in the Side panel URL: it would leak through browser history, `Referer` and proxy logs, and the plugin ignores a key found there. A static host also needs the Overturn API to allow that origin (CORS), or you should use the proxy.

Optional query or Front entry-point properties (same names as the Zendesk app, plus `overturn_proxy_url`):

- `overturn_base_url` (self-hosting; default `https://api.overturn.run`)
- `overturn_proxy_url` (the proxy origin; when set, the iframe does not send a key)
- `reason_pack`: `support` (default) or `claims`
- `agent`: the workflow name, one regression suite per workflow (default `support-reply`)
- `decision_fields`: custom fields that *are* the decision, as `id:label` pairs, e.g. `fld_123:status, fld_456:reserve`
- `require_reason`, `capture_internal_notes`, `min_draft_chars`, `scope_tag`

## Replay what it captured

```bash
overturn cases list --agent support-reply
overturn replay --model openai/gpt-4.1-mini,together/deepseek-ai/DeepSeek-V4.1-Flash --agent support-reply
```

Captures use `source: "front"` and `externalId: "fr:<conversation id>"`. The actor is the teammate looking at the panel. The address a message was sent *from* is recorded as provenance only: on a shared inbox that address is the inbox, not the person who clicked Send, and it is never used to accept or reject a capture.

`draft:inserted` / `draft:preloaded` / `draft:recorded` / `draft:manual` tags follow the Zendesk app, so the Capture scorecard's AI / manual / unknown split stays comparable across tools.

## Development

```bash
pnpm --filter @overturn-ai/front-plugin test      # payload builder, send observation, conversation isolation
pnpm --filter @overturn-ai/front-plugin build
```

`src/capture.ts` is the payload logic (pure, tested, the same shape as the Zendesk app); `src/glue.ts` is the Front-specific session (also tested, with a mocked HTTP surface); `src/main.ts` is the Plugin SDK and DOM glue; `app/` is the iframe page and styles.
