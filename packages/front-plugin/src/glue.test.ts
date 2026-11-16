import { describe, expect, it } from "vitest";
import { type ConversationSnapshot, DEFAULT_SETTINGS } from "./capture";
import {
  actorFromTeammate,
  captureEndpoint,
  FrontCaptureController,
  type ListedMessage,
  observeNewComments,
  observeNewOutbound,
  pickSentMessage,
  rawFromSearch,
  sendProvenance,
  settingsFromSources,
  snapshotFrom,
  UNLOAD_TIMEOUT_MS,
} from "./glue";

const draftText =
  "<p>Hi Dana,</p><p>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</p>";

function conversation(): ConversationSnapshot {
  return {
    id: "cnv_48213",
    subject: "Roof leak after storm",
    requesterHandle: "dana@example.com",
    requesterName: "Dana",
    messages: [
      {
        id: "msg_in",
        value: "Water came through the ceiling.",
        type: "publicReply",
        authorHandle: "dana@example.com",
        isAgent: false,
        createdAt: "2026-10-01T10:00:00Z",
      },
    ],
    fields: {},
    url: "https://app.frontapp.com/open/cnv_48213",
  };
}

function listed(partial: Partial<ListedMessage> & Pick<ListedMessage, "id" | "status">): ListedMessage {
  return {
    fromHandle: "support@inbox.example",
    fromName: "Support",
    createdAt: "2026-10-01T11:00:00Z",
    ...partial,
  };
}

describe("settingsFromSources", () => {
  it("ignores a project key in the plugin URL and lets the form or entry point supply it", () => {
    const { settings, urlKeyIgnored } = settingsFromSources({
      stored: { overturn_api_key: "ov_live_form", agent: "from-form" },
      url: {
        overturn_api_key: "ov_live_url",
        overturn_base_url: "https://ov.internal/",
        agent: "from-url",
      },
      entryPoint: { reason_pack: "claims" },
    });
    expect(urlKeyIgnored).toBe(true);
    expect(settings.apiKey).toBe("ov_live_form");
    expect(settings.baseUrl).toBe("https://ov.internal");
    expect(settings.agent).toBe("from-url");
    expect(settings.reasonPack).toBe("claims");
  });

  it("parses the query string and never treats a blank key as present", () => {
    const raw = rawFromSearch("?agent=claims-reply&overturn_api_key=");
    expect(raw).toEqual({ agent: "claims-reply", overturn_api_key: "" });
    expect(settingsFromSources({ url: raw }).urlKeyIgnored).toBe(false);
  });
});

describe("captureEndpoint", () => {
  it("posts through the proxy without a browser key, otherwise to the API", () => {
    const proxied = captureEndpoint({
      ...DEFAULT_SETTINGS,
      proxyUrl: "https://plugin.example",
      apiKey: "secret",
    });
    expect(proxied).toEqual({
      url: "https://plugin.example/v1/capture",
      apiKey: "",
      runsUrl: proxied.runsUrl,
    });
    expect(proxied.runsUrl("fr:cnv_1", "support-reply")).toBe(
      "https://plugin.example/v1/runs?externalId=fr%3Acnv_1&agent=support-reply&limit=1",
    );
    const direct = captureEndpoint({ ...DEFAULT_SETTINGS, apiKey: "ov_live_x" });
    expect(direct.url).toBe("https://api.overturn.run/v1/capture");
    expect(direct.apiKey).toBe("ov_live_x");
    const sameOrigin = captureEndpoint({ ...DEFAULT_SETTINGS, apiKey: "" }, "https://host.example");
    expect(sameOrigin.url).toBe("https://host.example/v1/capture");
    expect(sameOrigin.apiKey).toBe("");
  });
});

describe("actor and provenance", () => {
  it("uses the teammate in the panel, never the shared inbox on message.from", () => {
    expect(actorFromTeammate({ email: "ray@carrier.com", name: "Ray" })).toBe("ray@carrier.com");
    const prov = sendProvenance(
      listed({ id: "msg_out", status: "outbound", body: draftText, fromHandle: "support@inbox.example" }),
      "ray@carrier.com",
    );
    expect(prov).toEqual({
      sentFrom: "support@inbox.example",
      actorMatchesSentFrom: false,
      sentMessageId: "msg_out",
    });
  });
});

describe("observe and pick the sent message", () => {
  it("waits when a new outbound has no body yet", () => {
    const seen = new Set(["msg_in"]);
    expect(
      observeNewOutbound(seen, [
        listed({ id: "msg_in", status: "inbound", body: "hello" }),
        listed({ id: "msg_out", status: "outbound" }), // body undefined
      ]),
    ).toEqual({ kind: "unloaded", ids: ["msg_out"] });
  });

  it("prefers the outbound that matches the last composer text over a later message", () => {
    const later = "<p>An automatic follow-up.</p>";
    const picked = pickSentMessage(
      [
        { id: "msg_a", body: draftText, kind: "publicReply" },
        { id: "msg_b", body: later, kind: "publicReply" },
      ],
      draftText,
    );
    expect(picked?.id).toBe("msg_a");
    expect(pickSentMessage([{ id: "msg_b", body: later, kind: "publicReply" }], draftText)?.id).toBe("msg_b");
  });

  it("lists new comments only when they are actually new", () => {
    expect(
      observeNewComments(new Set(["c1"]), [
        { id: "c1", body: "old" },
        { id: "c2", body: "new note" },
      ]),
    ).toEqual([{ id: "c2", body: "new note", kind: "internalNote" }]);
  });
});

describe("snapshotFrom", () => {
  it("maps inbound/outbound and comments, oldest first", () => {
    const snap = snapshotFrom({
      conversationId: "cnv_48213",
      subject: "Roof leak after storm",
      requesterHandle: "dana@example.com",
      requesterName: "Dana",
      messages: [
        listed({
          id: "msg_out",
          status: "outbound",
          body: "We will help.",
          createdAt: "2026-10-01T11:00:00Z",
        }),
        listed({
          id: "msg_in",
          status: "inbound",
          body: "Help",
          fromHandle: "dana@example.com",
          createdAt: "2026-10-01T10:00:00Z",
        }),
      ],
      comments: [{ id: "c1", body: "HO-3", authorName: "Ray", createdAt: "2026-10-01T10:30:00Z" }],
      fields: {},
    });
    expect(snap.messages.map((m) => m.id)).toEqual(["msg_in", "c1", "msg_out"]);
    expect(snap.messages[0]?.isAgent).toBe(false);
    expect(snap.messages[1]?.type).toBe("internalNote");
    expect(snap.messages[2]?.isAgent).toBe(true);
    expect(snap.url).toBe("https://app.frontapp.com/open/cnv_48213");
  });
});

describe("FrontCaptureController", () => {
  const inbound = listed({
    id: "msg_in",
    status: "inbound",
    body: "Water came through the ceiling.",
    fromHandle: "dana@example.com",
    createdAt: "2026-10-01T10:00:00Z",
  });

  it("does not allow reading the thread until a draft exists, even in scope", () => {
    const c = new FrontCaptureController();
    c.openConversation("cnv_48213", [], "ray@carrier.com");
    expect(c.mayReadThread()).toBe(false);
    expect(c.view().mayReadThread).toBe(false);
    c.feedComposer("", 0);
    c.feedComposer(draftText, 50);
    expect(c.view().status).toMatch(/^Draft inserted · \d+ words$/);
    expect(c.mayReadThread()).toBe(true);
  });

  it("a conversation without the scope tag is never read, not even the composer", () => {
    const c = new FrontCaptureController({ ...DEFAULT_SETTINGS, scopeTag: "ai_drafted" });
    c.openConversation("cnv_48213", ["billing"], "ray@carrier.com");
    expect(c.scoped()).toBe(false);
    expect(c.mayReadThread()).toBe(false);
    c.feedComposer(draftText, 50);
    // feedComposer itself is only called by the glue when in scope; mayReadThread still refuses
    expect(c.mayReadThread()).toBe(false);
  });

  it("captures a shared-inbox send with the teammate as actor and the inbox as provenance only", async () => {
    const c = new FrontCaptureController({ ...DEFAULT_SETTINGS, requireReason: false });
    c.openConversation("cnv_48213", [], "ray@carrier.com");
    c.feedComposer("", 0);
    c.feedComposer(draftText, 20);
    c.seedSeen(["msg_in"]);
    const outbound = listed({
      id: "msg_out",
      status: "outbound",
      body: draftText,
      fromHandle: "support@inbox.example",
    });
    const result = c.ingestThread({
      snapshot: conversation(),
      messages: [inbound, outbound],
      comments: [],
      now: 5000,
    });
    expect(result.action).toBe("capture");
    if (result.action !== "capture") return;
    expect(result.body.source).toBe("front");
    expect(result.body.externalId).toBe("fr:cnv_48213");
    expect(result.body.actor).toBe("ray@carrier.com");
    expect(result.body.metadata).toMatchObject({
      sentFrom: "support@inbox.example",
      actorMatchesSentFrom: false,
      sentMessageId: "msg_out",
    });
    expect(result.provenance.actorMatchesSentFrom).toBe(false);
  });

  it("keeps the draft and the picked reason when the sent body has not loaded yet, then captures once it appears", () => {
    const c = new FrontCaptureController({ ...DEFAULT_SETTINGS, requireReason: false });
    c.openConversation("cnv_48213", [], "ray@carrier.com");
    c.feedComposer("", 0);
    c.feedComposer(draftText, 20);
    c.setReason("wrong_amount_or_date", "note");
    c.seedSeen(["msg_in"]);
    const unloaded = c.ingestThread({
      snapshot: conversation(),
      messages: [inbound, listed({ id: "msg_out", status: "outbound" })],
      comments: [],
      now: 1_000,
    });
    expect(unloaded.action).toBe("wait-unloaded");
    expect(c.detector.current()?.text).toBe(draftText);
    expect(c.reasonCode).toBe("wrong_amount_or_date");
    const ready = c.ingestThread({
      snapshot: conversation(),
      messages: [inbound, listed({ id: "msg_out", status: "outbound", body: draftText })],
      comments: [],
      now: 2_000,
    });
    expect(ready.action).toBe("capture");
    if (ready.action !== "capture") return;
    expect(ready.body.draft.text).toContain("5 business days");
  });

  it("gives up on an unloaded body after five minutes and says so, without hanging forever", () => {
    const c = new FrontCaptureController({ ...DEFAULT_SETTINGS, requireReason: false });
    c.openConversation("cnv_48213", [], "ray@carrier.com");
    c.feedComposer(draftText, 20);
    c.seedSeen(["msg_in"]);
    c.ingestThread({
      snapshot: conversation(),
      messages: [inbound, listed({ id: "msg_out", status: "outbound" })],
      comments: [],
      now: 1_000,
    });
    const expired = c.ingestThread({
      snapshot: conversation(),
      messages: [inbound, listed({ id: "msg_out", status: "outbound" })],
      comments: [],
      now: 1_000 + UNLOAD_TIMEOUT_MS + 1,
    });
    expect(expired.action).toBe("expired-unloaded");
    expect(c.view().note).toMatch(/could not read the sent reply/i);
    // a later poll must not wait again on the same id
    const later = c.ingestThread({
      snapshot: conversation(),
      messages: [inbound, listed({ id: "msg_out", status: "outbound" })],
      comments: [],
      now: 1_000 + UNLOAD_TIMEOUT_MS + 50,
    });
    expect(later.action).toBe("noop");
  });

  it("holds a changed send until a reason is picked, without treating Front's Send as vetoable", () => {
    const c = new FrontCaptureController(DEFAULT_SETTINGS);
    c.openConversation("cnv_48213", [], "ray@carrier.com");
    c.feedComposer("", 0);
    c.feedComposer(draftText, 20);
    c.seedSeen(["msg_in"]);
    const sent = draftText.replace("covered", "not covered");
    const held = c.ingestThread({
      snapshot: conversation(),
      messages: [inbound, listed({ id: "msg_out", status: "outbound", body: sent })],
      comments: [],
      now: 5_000,
    });
    expect(held.action).toBe("need-reason");
    expect(c.view().waitingForReason).toBe(true);
    expect(c.view().status).toMatch(/Pick why you changed/);
    const still = c.ingestThread({
      snapshot: conversation(),
      messages: [inbound, listed({ id: "msg_out", status: "outbound", body: sent })],
      comments: [],
      now: 6_000,
    });
    expect(still.action).toBe("need-reason");
    const noteOnly = c.setNote("a note is not enough");
    expect(noteOnly.action).toBe("need-reason");
    const ok = c.setReason("missed_exclusion", "exclusion");
    expect(ok.action).toBe("capture");
    if (ok.action !== "capture") return;
    expect(ok.body.reasonCode).toBe("missed_exclusion");
    expect(ok.body.source).toBe("front");
  });

  it("clears the reason at the end of a cycle so it cannot label the next reply", () => {
    const c = new FrontCaptureController({ ...DEFAULT_SETTINGS, requireReason: false });
    c.openConversation("cnv_48213", [], "ray@carrier.com");
    c.feedComposer(draftText, 20);
    c.setReason("tone_wording", "soften");
    c.seedSeen(["msg_in"]);
    const first = c.ingestThread({
      snapshot: conversation(),
      messages: [inbound, listed({ id: "msg_out", status: "outbound", body: draftText })],
      comments: [],
      now: 5_000,
    });
    expect(first.action).toBe("capture");
    c.onCaptureResult({
      ok: true,
      result: {
        runId: "r1",
        stepId: "s1",
        kind: "approve",
        changed: false,
        changedFields: [],
        correction: {} as never,
        case: null,
        deduplicated: false,
      },
    });
    expect(c.reasonCode).toBeNull();
    expect(c.reason).toBe("");
    expect(c.detector.current()).toBeNull();
    expect(c.view().status).toBe("Sent as drafted · approved");
  });

  it("switching conversations drops the reason, the held send and the draft so A cannot label B", () => {
    const c = new FrontCaptureController(DEFAULT_SETTINGS);
    c.openConversation("cnv_A", [], "ray@carrier.com");
    c.feedComposer(draftText, 20);
    c.seedSeen(["msg_in"]);
    const sent = draftText.replace("covered", "not covered");
    c.ingestThread({
      snapshot: { ...conversation(), id: "cnv_A" },
      messages: [inbound, listed({ id: "msg_out_a", status: "outbound", body: sent })],
      comments: [],
      now: 5_000,
    });
    expect(c.view().waitingForReason).toBe(true);
    c.openConversation("cnv_B", [], "ray@carrier.com");
    expect(c.reasonCode).toBeNull();
    expect(c.reason).toBe("");
    expect(c.held).toBeNull();
    expect(c.detector.current()).toBeNull();
    expect(c.mayReadThread()).toBe(false);
    expect(c.conversationId).toBe("cnv_B");
  });

  it("a failed capture keeps the pending body for retry and never throws", () => {
    const c = new FrontCaptureController({ ...DEFAULT_SETTINGS, requireReason: false });
    c.openConversation("cnv_48213", [], "ray@carrier.com");
    c.feedComposer(draftText, 20);
    c.seedSeen(["msg_in"]);
    const first = c.ingestThread({
      snapshot: conversation(),
      messages: [inbound, listed({ id: "msg_out", status: "outbound", body: draftText })],
      comments: [],
      now: 5_000,
    });
    expect(first.action).toBe("capture");
    c.onCaptureResult({ ok: false, error: "503" }, 5_000);
    expect(c.view().note).toMatch(/503/);
    expect(c.detector.current()).not.toBeNull();
    const retry = c.ingestThread({
      snapshot: conversation(),
      messages: [inbound, listed({ id: "msg_out", status: "outbound", body: draftText })],
      comments: [],
      now: 6_000,
    });
    expect(retry.action).toBe("wait-retry");
    expect(c.pendingBody?.externalId).toBe("fr:cnv_48213");
  });
});

describe("seedSeenFromThread", () => {
  it("still captures a send that already landed on the first listing after the draft", () => {
    const c = new FrontCaptureController({ ...DEFAULT_SETTINGS, requireReason: false });
    c.openConversation("cnv_48213", [], "ray@carrier.com");
    const draftAt = Date.parse("2026-10-01T12:00:00Z");
    c.feedComposer("", draftAt - 5_000);
    c.feedComposer(draftText, draftAt);
    const inbound = listed({
      id: "msg_in",
      status: "inbound",
      body: "Water came through the ceiling.",
      fromHandle: "dana@example.com",
      createdAt: "2026-10-01T10:00:00Z",
    });
    const prior = listed({
      id: "msg_old",
      status: "outbound",
      body: "Earlier reply.",
      createdAt: "2026-10-01T11:00:00Z",
    });
    const sent = listed({
      id: "msg_out",
      status: "outbound",
      body: draftText,
      createdAt: "2026-10-01T12:00:01Z",
    });
    c.seedSeenFromThread([inbound, prior, sent], []);
    expect(c.seenIds.has("msg_in")).toBe(true);
    expect(c.seenIds.has("msg_old")).toBe(true);
    expect(c.seenIds.has("msg_out")).toBe(false);
    const result = c.ingestThread({
      snapshot: conversation(),
      messages: [inbound, prior, sent],
      comments: [],
      now: draftAt + 2_000,
    });
    expect(result.action).toBe("capture");
    if (result.action === "capture") expect(result.body.externalId).toBe("fr:cnv_48213");
  });
});
