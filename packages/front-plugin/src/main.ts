import type {
  ApplicationComment,
  ApplicationCustomAttribute,
  ApplicationDraft,
  ApplicationDraftId,
  ApplicationMessage,
  ApplicationPaginationToken,
  ApplicationSingleConversation,
  EntryPointData,
} from "@frontapp/plugin-sdk";
import Front from "@frontapp/plugin-sdk";
import type { CaptureResult } from "@overturn-ai/shared";
import { bodyText, fieldsFromCustomAttributes, frontConversationUrl, quickReasons } from "./capture";
import {
  type ApplyResult,
  actorFromTeammate,
  FrontCaptureController,
  fetchRecordedDraft,
  type ListedComment,
  type ListedMessage,
  postCaptureWithEndpoint,
  rawFromSearch,
  SETTINGS_STORAGE_KEY,
  settingsFromSources,
  snapshotFrom,
} from "./glue";

const POLL_MS = 1500;

type ConversationCtx = {
  teammate: { email: string; name: string };
  conversation?: ApplicationSingleConversation;
  draft?: ApplicationDraft;
  entryPoint?: EntryPointData;
  fetchDraft?: (draftId: ApplicationDraftId) => Promise<ApplicationDraft | undefined>;
  listMessages: (token?: ApplicationPaginationToken) => Promise<{
    results: ReadonlyArray<ApplicationMessage>;
    nextPageToken: ApplicationPaginationToken | undefined;
  }>;
  listComments: (token?: ApplicationPaginationToken) => Promise<{
    results: ReadonlyArray<ApplicationComment>;
    nextPageToken: ApplicationPaginationToken | undefined;
  }>;
};

function asConversationCtx(ctx: unknown): ConversationCtx | null {
  if (typeof ctx !== "object" || ctx === null) return null;
  const rec = ctx as Record<string, unknown>;
  if (typeof rec.listMessages !== "function" || typeof rec.listComments !== "function") return null;
  const teammate = rec.teammate;
  if (typeof teammate !== "object" || teammate === null) return null;
  return rec as unknown as ConversationCtx;
}

function customContextProperties(entryPoint: EntryPointData | undefined): Record<string, unknown> | null {
  if (entryPoint && entryPoint.type === "URL" && "data" in entryPoint) {
    return { ...entryPoint.data.customContextProperties };
  }
  return null;
}

function storedSettings(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function saveStoredSettings(raw: Record<string, unknown>): void {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(raw));
}

function contentBody(content: { body: string; type: "html" | "text" } | undefined): string | undefined {
  if (!content) return undefined;
  return bodyText(content);
}

function iso(d: Date | undefined): string | null {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

function attributeValue(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

async function listAll<T>(
  page: (
    token?: ApplicationPaginationToken,
  ) => Promise<{ results: ReadonlyArray<T>; nextPageToken: ApplicationPaginationToken | undefined }>,
  cap = 8,
): Promise<T[]> {
  const out: T[] = [];
  let token: ApplicationPaginationToken | undefined;
  for (let i = 0; i < cap; i++) {
    const batch = await page(token);
    out.push(...batch.results);
    if (!batch.nextPageToken) break;
    token = batch.nextPageToken;
  }
  return out;
}

function listedMessages(messages: readonly ApplicationMessage[]): ListedMessage[] {
  return messages.map((m) => ({
    id: String(m.id),
    status: m.status,
    body: contentBody(m.content),
    fromHandle: m.from?.handle ?? null,
    fromName: m.from?.name ?? null,
    createdAt: iso(m.date),
  }));
}

function listedComments(comments: readonly ApplicationComment[]): ListedComment[] {
  return comments.map((c) => ({
    id: String(c.id),
    body: c.content.body,
    authorName: c.author.name,
    authorHandle: c.author.email,
    createdAt: iso(c.createdAt),
  }));
}

function requesterOf(conversation: ApplicationSingleConversation): {
  handle: string | null;
  name: string | null;
} {
  const r = conversation.recipient;
  return { handle: r?.handle ?? null, name: r?.name ?? null };
}

function tagNames(conversation: ApplicationSingleConversation): string[] {
  return conversation.tags.map((t) => t.name);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

async function jsonRequest(url: string, apiKey: string, method: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw Object.assign(new Error(String(res.status)), { status: res.status });
  return res.json();
}

function fieldAttributes(
  attrs: ReadonlyArray<ApplicationCustomAttribute>,
): Array<{ id: string; name: string; value: unknown }> {
  return attrs.map((a) => ({ id: String(a.id), name: a.name, value: attributeValue(a.value) }));
}

async function main(): Promise<void> {
  const { settings: initial, urlKeyIgnored } = settingsFromSources({
    stored: storedSettings(),
    url: rawFromSearch(location.search),
  });
  let settings = initial;
  const controller = new FrontCaptureController(settings);
  const sameOrigin = location.origin;

  const root = document.getElementById("app")!;
  const status = el("div", { class: "status" }, "Waiting for a draft");
  let reasonCode: string | null = null;
  const quick = el("div", { class: "quick", role: "radiogroup", "aria-label": "Why did you change it?" });
  const chips: HTMLButtonElement[] = [];
  const rebuildChips = (): void => {
    quick.replaceChildren();
    chips.length = 0;
    for (const q of quickReasons(settings)) {
      const b = el(
        "button",
        { type: "button", class: "chip", "data-code": q.code },
        q.label,
      ) as HTMLButtonElement;
      b.addEventListener("click", () => {
        reasonCode = reasonCode === q.code ? null : q.code;
        for (const c of chips) c.classList.toggle("on", c.dataset.code === reasonCode);
        void apply(controller.setReason(reasonCode, reason.value));
      });
      chips.push(b);
      quick.appendChild(b);
    }
  };
  const reason = el("textarea", {
    class: "reason",
    rows: "2",
    placeholder: "Anything else? Optional.",
  }) as HTMLTextAreaElement;
  reason.addEventListener("change", () => {
    void apply(controller.setNote(reason.value));
  });
  const mark = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  const settingsLink = el("button", { type: "button", class: "link" }, "Plugin settings");
  const note = el("div", { class: "note" }, "");
  const form = el("form", { class: "settings", hidden: "hidden" });
  const field = (name: string, label: string, value: string, extra: Record<string, string> = {}) => {
    const wrap = el("label", { class: "field" });
    wrap.append(el("span", {}, label), el("input", { name, value, ...extra }) as HTMLInputElement);
    return wrap;
  };
  form.append(
    field("overturn_base_url", "Overturn API URL", settings.baseUrl),
    field(
      "overturn_proxy_url",
      "Proxy URL (recommended; keeps the key off this page)",
      settings.proxyUrl ?? "",
    ),
    field("overturn_api_key", "Project API key (only if you are not using a proxy)", settings.apiKey, {
      type: "password",
      autocomplete: "off",
    }),
    field("agent", "Workflow (agent)", settings.agent),
    field("reason_pack", "Reason pack (support or claims)", settings.reasonPack),
    field("decision_fields", "Decision fields (id:label, …)", ""),
    field("scope_tag", "Only watch this tag (optional)", settings.scopeTag ?? ""),
    field("min_draft_chars", "Minimum draft characters", String(settings.minDraftChars)),
  );
  const requireRow = el("label", { class: "field check" });
  const requireBox = el("input", { type: "checkbox", name: "require_reason" }) as HTMLInputElement;
  requireBox.checked = settings.requireReason;
  requireRow.append(requireBox, document.createTextNode(" Require a reason when the reply changed"));
  const notesRow = el("label", { class: "field check" });
  const notesBox = el("input", { type: "checkbox", name: "capture_internal_notes" }) as HTMLInputElement;
  notesBox.checked = settings.captureInternalNotes;
  notesRow.append(notesBox, document.createTextNode(" Capture internal comments"));
  const save = el("button", { type: "submit", class: "chip on" }, "Save settings") as HTMLButtonElement;
  form.append(requireRow, notesRow, save);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw: Record<string, unknown> = {};
    for (const input of Array.from(form.querySelectorAll("input"))) {
      if (!(input instanceof HTMLInputElement) || !input.name) continue;
      raw[input.name] = input.type === "checkbox" ? (input.checked ? "true" : "false") : input.value;
    }
    saveStoredSettings(raw);
    const next = settingsFromSources({
      stored: raw,
      url: rawFromSearch(location.search),
      entryPoint: lastEntryPoint,
    });
    settings = next.settings;
    controller.settings = settings;
    rebuildChips();
    form.hidden = true;
    render();
  });
  settingsLink.addEventListener("click", () => {
    form.hidden = !form.hidden;
  });
  rebuildChips();
  root.append(status, quick, reason, mark, settingsLink, form, note);

  let lastEntryPoint: Record<string, unknown> | null = null;
  let lastDraftBody: string | null = null;
  let ctx: ConversationCtx | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let fetchingRecordedFor: string | null = null;

  const render = (): void => {
    const v = controller.view();
    if (!controller.conversationId) {
      status.textContent = "Open a conversation to capture a draft";
    } else if (!v.inScope) {
      status.textContent = `Not watching: no "${settings.scopeTag}" tag`;
    } else {
      status.textContent = v.status;
    }
    note.textContent =
      (urlKeyIgnored
        ? "The project key was removed from this page's URL so it is not leaked via history or Referer. Use the settings form or a proxy. "
        : "") + v.note;
    const hide = !controller.conversationId || !v.inScope;
    quick.hidden = hide;
    reason.hidden = hide;
    mark.hidden = hide;
    reasonCode = controller.reasonCode;
    for (const c of chips) c.classList.toggle("on", c.dataset.code === reasonCode);
  };

  const apply = async (result: ApplyResult): Promise<void> => {
    if (result.action === "capture") {
      const posted = await postCaptureWithEndpoint(
        (url, body, apiKey) => jsonRequest(url, apiKey, "POST", body) as Promise<CaptureResult>,
        settings,
        result.body,
        sameOrigin,
      );
      controller.onCaptureResult(posted);
      if (posted.ok) {
        reason.value = "";
        reasonCode = null;
        for (const c of chips) c.classList.remove("on");
        if (posted.result.changed && posted.result.case) {
          note.textContent = `Case: ${posted.result.case.title}`;
        }
      }
    }
    render();
  };

  const composerBody = async (): Promise<string | null> => {
    if (!ctx) return null;
    if (ctx.draft?.content) return contentBody(ctx.draft.content) ?? "";
    const draftId = ctx.conversation?.draftId;
    if (draftId && ctx.fetchDraft) {
      try {
        const draft = await ctx.fetchDraft(draftId);
        return draft?.content ? (contentBody(draft.content) ?? "") : "";
      } catch {
        return lastDraftBody;
      }
    }
    return lastDraftBody;
  };

  const syncComposer = async (): Promise<void> => {
    if (!ctx?.conversation || !controller.scoped()) return;
    const body = await composerBody();
    if (body === null) return;
    lastDraftBody = body;
    controller.feedComposer(body);
    render();
  };

  const loadThread = async (): Promise<{
    messages: ListedMessage[];
    comments: ListedComment[];
    fields: ReturnType<typeof fieldsFromCustomAttributes>;
  } | null> => {
    if (!ctx?.conversation || !controller.mayReadThread()) return null;
    const [messages, comments] = await Promise.all([
      listAll((token) => ctx!.listMessages(token)),
      listAll((token) => ctx!.listComments(token)),
    ]);
    const fields = fieldsFromCustomAttributes(
      fieldAttributes(ctx.conversation.customFieldAttributes).map((a) => ({
        id: a.id,
        name: a.name,
        value: a.value,
      })),
      settings.decisionFields,
    );
    return { messages: listedMessages(messages), comments: listedComments(comments), fields };
  };

  const tick = async (): Promise<void> => {
    if (document.visibilityState === "hidden") return;
    await syncComposer();
    if (!ctx?.conversation || !controller.mayReadThread()) return;
    try {
      const thread = await loadThread();
      if (!thread) return;
      const snap = snapshotFrom({
        conversationId: String(ctx.conversation.id),
        subject: ctx.conversation.subject ?? null,
        requesterHandle: requesterOf(ctx.conversation).handle,
        requesterName: requesterOf(ctx.conversation).name,
        messages: thread.messages,
        comments: thread.comments,
        fields: thread.fields,
        url: frontConversationUrl(String(ctx.conversation.id)),
      });
      if (controller.seenIds.size === 0) {
        controller.seedSeenFromThread(thread.messages, thread.comments);
      }
      await apply(
        controller.ingestThread({ snapshot: snap, messages: thread.messages, comments: thread.comments }),
      );
    } catch (e) {
      const statusCode = (e as { status?: number }).status;
      controller.lastError = `Overturn could not read the conversation (${statusCode ?? "network"}).`;
      render();
    }
  };

  mark.addEventListener("click", async () => {
    const body = await composerBody();
    if (!body?.trim()) return;
    controller.markManual(body);
    render();
  });

  const adoptContext = async (next: ConversationCtx | null): Promise<void> => {
    ctx = next;
    lastEntryPoint = next ? customContextProperties(next.entryPoint) : null;
    if (lastEntryPoint) {
      const adopted = settingsFromSources({
        stored: storedSettings(),
        url: rawFromSearch(location.search),
        entryPoint: lastEntryPoint,
      });
      settings = adopted.settings;
      controller.settings = settings;
    }
    const conversation = next?.conversation;
    if (!conversation) {
      controller.leaveConversation();
      lastDraftBody = null;
      fetchingRecordedFor = null;
      render();
      return;
    }
    const id = String(conversation.id);
    controller.openConversation(id, tagNames(conversation), actorFromTeammate(next?.teammate ?? null));
    if (!controller.scoped()) {
      render();
      return;
    }
    await syncComposer();
    if (fetchingRecordedFor !== id && !controller.detector.current()) {
      fetchingRecordedFor = id;
      const recorded = await fetchRecordedDraft(
        (url, apiKey) =>
          jsonRequest(url, apiKey, "GET") as Promise<{
            items: Array<{ id: string; output: unknown; agent: string; model?: string | null }>;
          }>,
        settings,
        id,
        sameOrigin,
      );
      if (recorded && controller.conversationId === id && !controller.detector.current()) {
        controller.setRecorded(recorded.text, recorded.runId, recorded.model);
      }
    }
    render();
  };

  Front.contextUpdates.subscribe((raw) => {
    void adoptContext(asConversationCtx(raw));
  });
  pollTimer = setInterval(() => {
    void tick();
  }, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void tick();
  });
  void pollTimer;
  render();
}

void main();
