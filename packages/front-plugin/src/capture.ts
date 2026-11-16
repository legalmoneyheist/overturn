import type { CaptureAnswer, CaptureCreate, CaptureMessage, CaptureResult } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** What the plugin knows about the conversation, read through the Front Plugin SDK. */
export interface ConversationSnapshot {
  id: string;
  subject: string | null;
  requesterHandle: string | null;
  requesterName: string | null;
  /** Oldest first. */
  messages: Array<{
    id?: string;
    value: string;
    type: "publicReply" | "internalNote" | string;
    authorName?: string | null;
    authorHandle?: string | null;
    isAgent?: boolean;
    createdAt?: string | null;
  }>;
  /** Custom fields the admin chose as decision fields, by label. */
  fields: Record<string, unknown>;
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Hold a changed capture until the agent picks a reason (Front has no pre-send veto). */
  requireReason: boolean;
  /** Also capture internal comments, not only public replies. */
  captureInternalNotes: boolean;
  /** `field_id:coverage, field_id_2:reserve` → decision fields by label. */
  decisionFields: Array<{ id: string; label: string }>;
  /** Replies shorter than this never count as a draft (a typed greeting is not a draft). */
  minDraftChars: number;
  /** When set, the plugin watches only conversations carrying this tag; every other conversation is never read. */
  scopeTag: string | null;
  /** Which quick-pick reasons the agent sees: the claims pack or the vendor-neutral support pack. */
  reasonPack: ReasonPack;
  apiKey: string;
  /**
   * Optional same-origin (or dedicated) proxy that attaches the project key server-side.
   * When set, the iframe never holds `overturn_api_key`.
   */
  proxyUrl: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  captureInternalNotes: false,
  decisionFields: [],
  minDraftChars: 80,
  scopeTag: null,
  reasonPack: "support",
  apiKey: "",
  proxyUrl: null,
};

/** Parses the plugin's settings (strings and booleans from URL params, a form, or stored values). */
export function settingsFrom(raw: Record<string, unknown>): AppSettings {
  const str = (k: string): string | null => {
    const v = raw[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const bool = (k: string, d: boolean): boolean => {
    const v = raw[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v === "true" || v === "1";
    return d;
  };
  const fields = (str("decision_fields") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":").map((x) => x.trim());
      return { id: id!, label: label || id! };
    });
  const min = Number(str("min_draft_chars") ?? "");
  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    captureInternalNotes: bool("capture_internal_notes", DEFAULT_SETTINGS.captureInternalNotes),
    decisionFields: fields,
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    scopeTag: str("scope_tag"),
    reasonPack: reasonPackFrom(str("reason_pack")),
    apiKey: str("overturn_api_key") ?? DEFAULT_SETTINGS.apiKey,
    proxyUrl: str("overturn_proxy_url"),
  };
}

/**
 * Whether the plugin should watch this conversation at all. With no scope tag every conversation
 * is watched, but nothing is read beyond the composer until a draft appears. With a scope tag,
 * conversations without it are never read, not even the composer.
 */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

/**
 * Where the draft came from. The composer is watched: the first time it goes from (nearly)
 * empty to a reply-sized text in one change, that text was inserted (an AI assist, a macro,
 * a paste), not typed, and it is the draft. The agent can also mark the current text as the
 * draft by hand, and a drafting agent that recorded its run with the SDK is found by conversation id.
 */
export type DraftOrigin = "inserted" | "manual" | "recorded" | "preloaded";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
}

export interface DraftDetector {
  /** Feed every composer value; returns a draft the first time one appears. */
  onComposer(text: string, now?: number): DraftState | null;
  current(): DraftState | null;
  set(d: DraftState | null): void;
}

export function createDraftDetector(opts: { minDraftChars: number; typingWindowMs?: number }): DraftDetector {
  const window = opts.typingWindowMs ?? 1500;
  let draft: DraftState | null = null;
  let last = { text: "", at: 0 };
  let seen = false;
  return {
    onComposer(text, now = Date.now()) {
      const prev = last;
      const firstSight = !seen;
      seen = true;
      last = { text, at: now };
      if (draft) return null;
      const grew = text.length - prev.text.length;
      // A jump of reply size in one change (or a reply-sized composer on first sight).
      const jump =
        grew >= opts.minDraftChars && (prev.text.length < opts.minDraftChars / 2 || now - prev.at > window);
      const first = firstSight && text.length >= opts.minDraftChars;
      if (jump || first) {
        draft = { text, origin: first ? "preloaded" : "inserted", at: now };
        return draft;
      }
      return null;
    },
    current: () => draft,
    set: (d) => {
      draft = d;
    },
  };
}

function role(c: ConversationSnapshot["messages"][number]): CaptureMessage["role"] {
  if (c.type === "internalNote") return "note";
  return c.isAgent ? "agent" : "customer";
}

/** The thread the agent saw, oldest first, as capture context. */
export function contextFrom(conversation: ConversationSnapshot): CaptureMessage[] {
  return conversation.messages
    .filter((c) => c.value?.trim())
    .map((c) => ({
      role: role(c),
      author: c.authorHandle ?? c.authorName ?? null,
      content: stripHtml(c.value),
      at: c.createdAt ?? null,
    }));
}

/** Front drafts and messages may be HTML; the case wants the text the human read. */
export function stripHtml(html: string): string {
  return normalizeCaptureText(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

/** Plain text from a Front draft or message content body. */
export function bodyText(content: { body: string; type: "html" | "text" } | null | undefined): string {
  if (!content?.body) return "";
  return content.type === "html" ? content.body : content.body;
}

export function frontConversationUrl(conversationId: string): string {
  return `https://app.frontapp.com/open/${encodeURIComponent(conversationId)}`;
}

export function fieldsFromCustomAttributes(
  attributes: ReadonlyArray<{ id: string; name: string; value: unknown }>,
  decisionFields: Array<{ id: string; label: string }>,
): Record<string, unknown> {
  if (decisionFields.length === 0) return {};
  const byId = new Map(attributes.map((a) => [a.id, a]));
  const byName = new Map(attributes.map((a) => [a.name, a]));
  return Object.fromEntries(
    decisionFields.map((f) => {
      const attr = byId.get(f.id) ?? byName.get(f.id) ?? byName.get(f.label);
      return [f.label, attr?.value ?? null];
    }),
  );
}

export interface PendingSend {
  text: string;
  type: "publicReply" | "internalNote" | string;
  fields: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** What to do when a send is observed. Pure: the Front glue only forwards the answer. */
export function decideOnSend(input: {
  conversation: ConversationSnapshot;
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  send: PendingSend;
  /** The picked reason code, required for a changed send when requireReason is on. */
  reasonCode: string | null;
  /** Optional free-text note. */
  reason: string;
  actor: string | null;
  settings: AppSettings;
  /** When the send was observed; with the draft's `at`, gives how long it sat in front of the reviewer. */
  now?: number;
}): SendDecision {
  const { conversation, draft, send, settings } = input;
  const sentText = stripHtml(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (send.type === "internalNote" && !settings.captureInternalNotes)
    return { action: "skip", why: "internal-note" };
  if (!draft) return { action: "skip", why: "no-draft" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: input.draftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = { text: sentText, ...(hasFields ? { fields: send.fields } : {}) };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;
  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const body: CaptureCreate = {
    source: "front",
    externalId: `fr:${conversation.id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: conversation.subject,
    context: contextFrom(conversation),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 100) / 10),
    draftRunId: draft.runId ?? null,
    draftModel: draft.model ?? null,
    url: conversation.url,
    tags: [`draft:${draft.origin}`, send.type === "internalNote" ? "internal-note" : "public-reply"],
    metadata: { requester: conversation.requesterHandle ?? conversation.requesterName ?? null },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/**
 * Front's Plugin SDK has no pre-send hook (unlike Zendesk's `ticket.save`). A changed send
 * without a reason is remembered so the capture can go out once the agent picks one; Front's
 * own Send is never vetoed.
 */
export interface HeldSend {
  conversation: ConversationSnapshot;
  draft: DraftState;
  draftFields: Record<string, unknown>;
  send: PendingSend;
  actor: string | null;
  settings: AppSettings;
  now: number;
}

export function decideHeldSend(held: HeldSend, reasonCode: string | null, reason: string): SendDecision {
  return decideOnSend({
    conversation: held.conversation,
    draft: held.draft,
    draftFields: held.draftFields,
    send: held.send,
    reasonCode,
    reason,
    actor: held.actor,
    settings: held.settings,
    now: held.now,
  });
}

export interface OutboundMessage {
  id: string;
  body: string;
  kind: "publicReply" | "internalNote";
}

/** New outbound replies (or, when enabled, comments) that appeared since the last look. */
export function newOutboundSends(
  previousIds: ReadonlySet<string>,
  messages: ReadonlyArray<OutboundMessage>,
): OutboundMessage[] {
  return messages.filter((m) => m.body.trim() && !previousIds.has(m.id));
}

/** POST /v1/capture. Never throws: a failed capture must not interfere with the agent's send. */
export async function postCapture(
  post: (url: string, body: CaptureCreate, apiKey: string) => Promise<CaptureResult>,
  settings: AppSettings,
  body: CaptureCreate,
): Promise<{ ok: true; result: CaptureResult } | { ok: false; error: string }> {
  try {
    const result = await post(`${settings.baseUrl}/v1/capture`, body, settings.apiKey);
    return { ok: true, result };
  } catch (e) {
    const status = (e as { status?: number }).status;
    return { ok: false, error: String(status ?? (e instanceof Error ? e.message : "network")) };
  }
}

/** Short status line for the sidebar. */
export function statusLine(
  d: DraftState | null,
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null,
  waitingForReason = false,
): string {
  if (waitingForReason) return "Pick why you changed the reply so Overturn can save this case";
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  const words = d.text.trim().split(/\s+/).filter(Boolean).length;
  const from = {
    inserted: "inserted",
    manual: "marked by you",
    recorded: "recorded by your agent",
    preloaded: "found in the composer",
  }[d.origin];
  return `Draft ${from} · ${words} words`;
}

/** The chips the agent clicks, for the installed pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
