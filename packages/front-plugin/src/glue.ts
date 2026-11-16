import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  type ConversationSnapshot,
  createDraftDetector,
  DEFAULT_SETTINGS,
  type DraftDetector,
  type DraftState,
  decideHeldSend,
  decideOnSend,
  fieldsFromCustomAttributes,
  frontConversationUrl,
  type HeldSend,
  inScope,
  type OutboundMessage,
  type PendingSend,
  postCapture,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture";

export const SETTINGS_STORAGE_KEY = "overturn.front-plugin.settings";

/** A listed Front message. `body: undefined` means Front has not loaded the content yet. */
export interface ListedMessage {
  id: string;
  status: "inbound" | "outbound";
  /** `undefined` = content not available yet; empty string = loaded and empty. */
  body?: string;
  fromHandle?: string | null;
  fromName?: string | null;
  createdAt?: string | null;
}

export interface ListedComment {
  id: string;
  body: string;
  authorName?: string | null;
  authorHandle?: string | null;
  createdAt?: string | null;
}

export type ObserveResult =
  | { kind: "none" }
  | { kind: "unloaded"; ids: string[] }
  | { kind: "sends"; messages: OutboundMessage[] };

/**
 * New outbound replies since `previousIds`. If any of those arrivals have no body yet,
 * we wait — clearing the draft now would drop the capture for good.
 */
export function observeNewOutbound(
  previousIds: ReadonlySet<string>,
  messages: ReadonlyArray<ListedMessage>,
): ObserveResult {
  const newcomers = messages.filter((m) => m.status === "outbound" && !previousIds.has(m.id));
  if (newcomers.length === 0) return { kind: "none" };
  const unloaded = newcomers.filter((m) => m.body === undefined);
  if (unloaded.length > 0) return { kind: "unloaded", ids: unloaded.map((m) => m.id) };
  const ready: OutboundMessage[] = newcomers
    .filter((m) => (m.body ?? "").trim())
    .map((m) => ({ id: m.id, body: m.body ?? "", kind: "publicReply" }));
  return ready.length > 0 ? { kind: "sends", messages: ready } : { kind: "none" };
}

/** New internal comments, when the install captures them. */
export function observeNewComments(
  previousIds: ReadonlySet<string>,
  comments: ReadonlyArray<ListedComment>,
): OutboundMessage[] {
  return comments
    .filter((c) => c.body.trim() && !previousIds.has(c.id))
    .map((c) => ({ id: c.id, body: c.body, kind: "internalNote" }));
}

/**
 * Among new outbound bodies, prefer the one that still matches the last composer value
 * we saw (the actual send). Falling back to the oldest new outbound, never "whichever
 * message is latest on the thread".
 */
export function pickSentMessage(
  candidates: readonly OutboundMessage[],
  lastComposerText: string | null,
): OutboundMessage | null {
  if (candidates.length === 0) return null;
  if (lastComposerText) {
    const want = stripHtml(lastComposerText);
    const match = candidates.find((m) => stripHtml(m.body) === want);
    if (match) return match;
  }
  return candidates[0] ?? null;
}

/** The teammate looking at the panel is the actor — never `message.from`, which is the inbox. */
export function actorFromTeammate(
  teammate: { email?: string | null; name?: string | null } | null,
): string | null {
  const email = teammate?.email?.trim();
  if (email) return email;
  const name = teammate?.name?.trim();
  return name || null;
}

/** Provenance only: a shared inbox address is recorded, never used to accept or reject a capture. */
export function sendProvenance(
  message: ListedMessage | OutboundMessage,
  actor: string | null,
): { sentFrom: string | null; actorMatchesSentFrom: boolean; sentMessageId: string } {
  const sentFrom =
    "fromHandle" in message && typeof message.fromHandle === "string" ? message.fromHandle : null;
  return {
    sentFrom,
    actorMatchesSentFrom: Boolean(actor && sentFrom && actor.toLowerCase() === sentFrom.toLowerCase()),
    sentMessageId: message.id,
  };
}

export function snapshotFrom(input: {
  conversationId: string;
  subject: string | null;
  requesterHandle: string | null;
  requesterName: string | null;
  messages: readonly ListedMessage[];
  comments: readonly ListedComment[];
  fields: Record<string, unknown>;
  url?: string | null;
}): ConversationSnapshot {
  const messages: ConversationSnapshot["messages"] = [
    ...input.messages.map((m) => ({
      id: m.id,
      value: m.body ?? "",
      type: "publicReply" as const,
      authorName: m.fromName ?? null,
      authorHandle: m.fromHandle ?? null,
      isAgent: m.status === "outbound",
      createdAt: m.createdAt ?? null,
    })),
    ...input.comments.map((c) => ({
      id: c.id,
      value: c.body,
      type: "internalNote" as const,
      authorName: c.authorName ?? null,
      authorHandle: c.authorHandle ?? null,
      isAgent: true,
      createdAt: c.createdAt ?? null,
    })),
  ];
  messages.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  return {
    id: input.conversationId,
    subject: input.subject,
    requesterHandle: input.requesterHandle,
    requesterName: input.requesterName,
    messages,
    fields: input.fields,
    url: input.url ?? frontConversationUrl(input.conversationId),
  };
}

export const UNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
export const FAILED_RETRY_MS = 5 * 60 * 1000;

export type CaptureEndpoint = {
  url: string;
  apiKey: string;
  runsUrl: (externalId: string, agent: string) => string;
};

/** Direct to the API when the iframe has a key; otherwise through the same-origin / hosted proxy. */
export function captureEndpoint(settings: AppSettings, sameOrigin?: string | null): CaptureEndpoint {
  const proxy = settings.proxyUrl ?? (settings.apiKey ? null : (sameOrigin ?? null));
  const root = (proxy ?? settings.baseUrl).replace(/\/+$/, "");
  const apiKey = proxy ? "" : settings.apiKey;
  return {
    url: `${root}/v1/capture`,
    apiKey,
    runsUrl: (externalId, agent) =>
      `${root}/v1/runs?externalId=${encodeURIComponent(externalId)}&agent=${encodeURIComponent(agent)}&limit=1`,
  };
}

/**
 * Settings merge: stored form < URL query (for non-secrets) < Front entry-point properties.
 * A project key in the plugin URL is ignored: it would leak through history, Referer and proxy logs.
 */
export function settingsFromSources(input: {
  stored?: Record<string, unknown> | null;
  url?: Record<string, unknown> | null;
  entryPoint?: Record<string, unknown> | null;
}): { settings: AppSettings; urlKeyIgnored: boolean } {
  const url = { ...(input.url ?? {}) };
  const urlKeyIgnored = typeof url.overturn_api_key === "string" && Boolean(url.overturn_api_key.trim());
  delete url.overturn_api_key;
  const raw = { ...(input.stored ?? {}), ...url, ...(input.entryPoint ?? {}) };
  // entry-point / form may still carry the key; URL never does
  return { settings: settingsFrom(raw), urlKeyIgnored };
}

export function rawFromSearch(search: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const [k, v] of q.entries()) out[k] = v;
  return out;
}

export type ControllerView = {
  status: string;
  waitingForReason: boolean;
  note: string;
  conversationId: string | null;
  inScope: boolean;
  hasDraft: boolean;
  reasonCode: string | null;
  /** True once a draft exists, which is when the thread may be read. */
  mayReadThread: boolean;
};

export type ApplyResult =
  | { action: "noop" }
  | { action: "wait-unloaded" }
  | { action: "wait-retry" }
  | { action: "need-reason" }
  | { action: "capture"; body: CaptureCreate; provenance: ReturnType<typeof sendProvenance> }
  | { action: "expired-unloaded" };

/**
 * One conversation at a time. Switching conversations drops the reason, the held send
 * and the detector, so a chip picked on A cannot label a send on B.
 */
export class FrontCaptureController {
  settings: AppSettings;
  conversationId: string | null = null;
  actor: string | null = null;
  tags: string[] = [];
  detector: DraftDetector;
  seenIds = new Set<string>();
  draftFields: Record<string, unknown> = {};
  reasonCode: string | null = null;
  reason = "";
  held: HeldSend | null = null;
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  lastError: string | null = null;
  lastComposer: string | null = null;
  snapshot: ConversationSnapshot | null = null;
  unloadedSince: number | null = null;
  failedSince: number | null = null;
  pendingBody: CaptureCreate | null = null;
  pendingProvenance: ReturnType<typeof sendProvenance> | null = null;

  constructor(settings: AppSettings = DEFAULT_SETTINGS) {
    this.settings = settings;
    this.detector = createDraftDetector({ minDraftChars: settings.minDraftChars });
  }

  scoped(): boolean {
    return inScope(this.tags, this.settings);
  }

  /** The thread is only listed after a draft is known, matching the issue's out-of-scope rule. */
  mayReadThread(): boolean {
    return this.scoped() && this.detector.current() !== null;
  }

  openConversation(id: string, tags: readonly string[], actor: string | null): void {
    if (this.conversationId === id) {
      this.tags = [...tags];
      this.actor = actor;
      return;
    }
    this.conversationId = id;
    this.tags = [...tags];
    this.actor = actor;
    this.detector = createDraftDetector({ minDraftChars: this.settings.minDraftChars });
    this.seenIds = new Set();
    this.draftFields = {};
    this.reasonCode = null;
    this.reason = "";
    this.held = null;
    this.lastResult = null;
    this.lastError = null;
    this.lastComposer = null;
    this.snapshot = null;
    this.unloadedSince = null;
    this.failedSince = null;
    this.pendingBody = null;
    this.pendingProvenance = null;
  }

  leaveConversation(): void {
    this.conversationId = null;
    this.tags = [];
    this.actor = null;
    this.detector = createDraftDetector({ minDraftChars: this.settings.minDraftChars });
    this.seenIds = new Set();
    this.draftFields = {};
    this.reasonCode = null;
    this.reason = "";
    this.held = null;
    this.lastResult = null;
    this.lastError = null;
    this.lastComposer = null;
    this.snapshot = null;
    this.unloadedSince = null;
    this.failedSince = null;
    this.pendingBody = null;
    this.pendingProvenance = null;
  }

  feedComposer(rawBody: string, now = Date.now()): DraftState | null {
    this.lastComposer = rawBody;
    const found = this.detector.onComposer(rawBody, now);
    // If a new draft cycle starts after a finished capture, drop a stale reason.
    if (found && !this.held) {
      this.lastResult = null;
      this.lastError = null;
    }
    return found;
  }

  markManual(rawBody: string, now = Date.now()): void {
    if (!rawBody.trim()) return;
    this.lastComposer = rawBody;
    this.detector.set({ text: rawBody, origin: "manual", at: now });
    this.lastResult = null;
    this.lastError = null;
  }

  setRecorded(text: string, runId: string, model: string | null, now = Date.now()): void {
    if (this.detector.current()) return;
    this.detector.set({ text, origin: "recorded", runId, model, at: now });
  }

  setReason(code: string | null, note?: string): ApplyResult {
    this.reasonCode = code;
    if (note !== undefined) this.reason = note;
    if (this.held) return this.resolveHeld();
    return { action: "noop" };
  }

  setNote(note: string): ApplyResult {
    this.reason = note;
    if (this.held) return this.resolveHeld();
    return { action: "noop" };
  }

  rememberDraftFields(fields: Record<string, unknown>): void {
    if (!this.detector.current()) return;
    if (Object.keys(this.draftFields).length === 0) this.draftFields = fields;
  }

  seedSeen(ids: Iterable<string>): void {
    for (const id of ids) this.seenIds.add(id);
  }

  /**
   * First listing after a draft appears may already include the send. Seed inbound
   * messages and clearly-older outbounds, but leave a new outbound (or one that still
   * matches the composer) to be observed as a send.
   */
  seedSeenFromThread(messages: readonly ListedMessage[], comments: readonly ListedComment[]): void {
    if (this.seenIds.size > 0) return;
    const want = this.lastComposer ? stripHtml(this.lastComposer) : null;
    const draftAt = this.detector.current()?.at ?? 0;
    for (const m of messages) {
      if (m.status === "inbound") {
        this.seenIds.add(m.id);
        continue;
      }
      const at = m.createdAt ? Date.parse(m.createdAt) : Number.NaN;
      const matchesComposer = Boolean(want && m.body !== undefined && stripHtml(m.body) === want);
      const clearlyOld = !Number.isNaN(at) && at < draftAt - 2000;
      if (!matchesComposer && (clearlyOld || Number.isNaN(at))) this.seenIds.add(m.id);
    }
    for (const c of comments) {
      const at = c.createdAt ? Date.parse(c.createdAt) : Number.NaN;
      if (Number.isNaN(at) || at < draftAt - 2000) this.seenIds.add(c.id);
    }
  }

  private resolveHeld(): ApplyResult {
    if (!this.held) return { action: "noop" };
    const decision = decideHeldSend(this.held, this.reasonCode, this.reason);
    if (decision.action === "need-reason") return { action: "need-reason" };
    if (decision.action === "skip") {
      this.held = null;
      return { action: "noop" };
    }
    const listed = {
      id: this.pendingProvenance?.sentMessageId ?? "held",
      body: this.held.send.text,
      kind: this.held.send.type === "internalNote" ? ("internalNote" as const) : ("publicReply" as const),
      fromHandle: null,
    };
    return {
      action: "capture",
      body: decision.body,
      provenance: this.pendingProvenance ?? sendProvenance(listed, this.actor),
    };
  }

  /**
   * Ingest the thread (only after a draft exists) and decide whether a new send should be captured.
   * Does not POST: the caller does, then `onCaptureResult`.
   */
  ingestThread(input: {
    snapshot: ConversationSnapshot;
    messages: readonly ListedMessage[];
    comments: readonly ListedComment[];
    now?: number;
  }): ApplyResult {
    if (!this.mayReadThread()) return { action: "noop" };
    const now = input.now ?? Date.now();
    this.snapshot = input.snapshot;
    this.rememberDraftFields(input.snapshot.fields);

    if (this.pendingBody && this.failedSince !== null) {
      if (now - this.failedSince <= FAILED_RETRY_MS) return { action: "wait-retry" };
      this.pendingBody = null;
      this.failedSince = null;
    }

    if (this.held) return { action: "need-reason" };

    const observed = observeNewOutbound(this.seenIds, input.messages);
    if (observed.kind === "unloaded") {
      this.unloadedSince ??= now;
      if (now - this.unloadedSince > UNLOAD_TIMEOUT_MS) {
        this.unloadedSince = null;
        for (const id of observed.ids) this.seenIds.add(id);
        this.lastError = "Overturn could not read the sent reply in time.";
        return { action: "expired-unloaded" };
      }
      return { action: "wait-unloaded" };
    }
    this.unloadedSince = null;

    const commentSends = this.settings.captureInternalNotes
      ? observeNewComments(this.seenIds, input.comments)
      : [];
    const publicSend =
      observed.kind === "sends" ? pickSentMessage(observed.messages, this.lastComposer) : null;
    const send = publicSend ?? commentSends[0] ?? null;
    if (!send) return { action: "noop" };

    const listed = input.messages.find((m) => m.id === send.id);
    const provenance = sendProvenance(
      listed ?? { id: send.id, status: "outbound", body: send.body, fromHandle: null },
      this.actor,
    );
    const pending: PendingSend = { text: send.body, type: send.kind, fields: input.snapshot.fields };
    const decision = decideOnSend({
      conversation: input.snapshot,
      draft: this.detector.current(),
      draftFields: this.draftFields,
      send: pending,
      reasonCode: this.reasonCode,
      reason: this.reason,
      actor: this.actor,
      settings: this.settings,
      now,
    });
    if (decision.action === "skip") {
      this.seenIds.add(send.id);
      return { action: "noop" };
    }
    if (decision.action === "need-reason") {
      const draft = this.detector.current();
      if (!draft) return { action: "noop" };
      this.held = {
        conversation: input.snapshot,
        draft,
        draftFields: this.draftFields,
        send: pending,
        actor: this.actor,
        settings: this.settings,
        now,
      };
      this.pendingProvenance = provenance;
      // Keep the send un-acked until a reason is picked so a retry still has it,
      // but do not re-prompt from the same ids on the next poll.
      this.seenIds.add(send.id);
      return { action: "need-reason" };
    }
    this.pendingProvenance = provenance;
    this.pendingBody = decision.body;
    this.pendingBody.metadata = {
      ...(decision.body.metadata ?? {}),
      sentFrom: provenance.sentFrom,
      actorMatchesSentFrom: provenance.actorMatchesSentFrom,
      sentMessageId: provenance.sentMessageId,
    };
    return { action: "capture", body: this.pendingBody, provenance };
  }

  onCaptureResult(
    result: { ok: true; result: CaptureResult } | { ok: false; error: string },
    now = Date.now(),
  ): void {
    if (result.ok) {
      this.lastResult = {
        kind: result.result.kind,
        changed: result.result.changed,
        dedup: result.result.deduplicated,
      };
      this.lastError = null;
      this.reasonCode = null;
      this.reason = "";
      this.held = null;
      this.detector.set(null);
      this.draftFields = {};
      this.unloadedSince = null;
      this.failedSince = null;
      if (this.pendingProvenance) this.seenIds.add(this.pendingProvenance.sentMessageId);
      this.pendingBody = null;
      this.pendingProvenance = null;
      return;
    }
    this.lastError = `Overturn could not save this correction (${result.error}).`;
    this.failedSince = now;
    // Leave the draft and the pending body so the next poll can retry the POST.
  }

  view(): ControllerView {
    const waiting = this.held !== null;
    const note = this.lastError ?? "";
    return {
      status: statusLine(this.detector.current(), this.lastResult, waiting),
      waitingForReason: waiting,
      note,
      conversationId: this.conversationId,
      inScope: this.scoped(),
      hasDraft: this.detector.current() !== null,
      reasonCode: this.reasonCode,
      mayReadThread: this.mayReadThread(),
    };
  }
}

export async function postCaptureWithEndpoint(
  post: (url: string, body: CaptureCreate, apiKey: string) => Promise<CaptureResult>,
  settings: AppSettings,
  body: CaptureCreate,
  sameOrigin?: string | null,
): Promise<{ ok: true; result: CaptureResult } | { ok: false; error: string }> {
  const ep = captureEndpoint(settings, sameOrigin);
  // postCapture always appends /v1/capture on baseUrl; call `post` directly with the resolved URL.
  try {
    const result = await post(ep.url, body, ep.apiKey);
    return { ok: true, result };
  } catch (e) {
    const status = (e as { status?: number }).status;
    return { ok: false, error: String(status ?? (e instanceof Error ? e.message : "network")) };
  }
}

/** Used when a recorded SDK run already exists for this conversation. */
export async function fetchRecordedDraft(
  getJson: (
    url: string,
    apiKey: string,
  ) => Promise<{ items: Array<{ id: string; output: unknown; agent: string; model?: string | null }> }>,
  settings: AppSettings,
  conversationId: string,
  sameOrigin?: string | null,
): Promise<{ text: string; runId: string; model: string | null } | null> {
  const ep = captureEndpoint(settings, sameOrigin);
  try {
    const found = await getJson(ep.runsUrl(`fr:${conversationId}`, settings.agent), ep.apiKey);
    const run = found.items[0];
    if (run && typeof run.output === "string" && run.output.trim()) {
      return { text: run.output, runId: run.id, model: run.model ?? null };
    }
  } catch {
    // no recorded draft; the composer is watched instead
  }
  return null;
}

export { fieldsFromCustomAttributes, inScope, postCapture, settingsFrom };
