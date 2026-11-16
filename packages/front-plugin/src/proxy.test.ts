import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowedApiPath,
  assertBodySize,
  createHandler,
  forwardApi,
  MAX_BODY_BYTES,
  safeStaticPath,
} from "../scripts/proxy.mjs";

describe("proxy allow-list", () => {
  it("forwards only POST /v1/capture and GET /v1/runs", () => {
    expect(allowedApiPath("POST", "/v1/capture")).toBe(true);
    expect(allowedApiPath("GET", "/v1/runs?externalId=fr%3A1&agent=support-reply&limit=1")).toBe(true);
    expect(allowedApiPath("GET", "/v1/capture")).toBe(false);
    expect(allowedApiPath("POST", "/v1/runs")).toBe(false);
    expect(allowedApiPath("POST", "/v1/capture/../secrets")).toBe(false);
    expect(allowedApiPath("DELETE", "/v1/capture")).toBe(false);
    expect(allowedApiPath("GET", "/v1/projects")).toBe(false);
  });

  it("rejects a body over 1 MiB", () => {
    expect(() => assertBodySize("x".repeat(MAX_BODY_BYTES + 1))).toThrow(/too large/);
  });

  it("refuses static paths that escape the root", () => {
    const root = "/tmp/overturn-front-app";
    expect(safeStaticPath(root, "/assets/main.js")).toBe(path.join(root, "assets/main.js"));
    expect(safeStaticPath(root, "/../secret.txt")).toBeNull();
  });
});

describe("forwardApi", () => {
  it("attaches the server-side key and never forwards the browser Authorization header", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ kind: "approve", changed: false, deduplicated: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const result = await forwardApi(
      {
        method: "POST",
        url: "/v1/capture",
        headers: {
          origin: "https://plugin.example",
          authorization: "Bearer stolen",
          "content-type": "application/json",
        },
      },
      JSON.stringify({ source: "front", externalId: "fr:1" }),
      { baseUrl: "https://api.overturn.run", apiKey: "ov_live_server", fetchImpl },
    );
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.overturn.run/v1/capture");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer ov_live_server");
    expect(result.body).not.toContain("ov_live_server");
    expect(result.headers["access-control-allow-origin"]).toBe("https://plugin.example");
  });

  it("does not leak the key in an upstream error body we did not write, and 404s other paths", async () => {
    const denied = await forwardApi(
      { method: "GET", url: "/v1/projects", headers: { origin: "https://plugin.example" } },
      "",
      {
        baseUrl: "https://api.overturn.run",
        apiKey: "ov_live_server",
        fetchImpl: async () => new Response("should not be called"),
      },
    );
    expect(denied).toMatchObject({ status: 404, body: "not found" });
    expect(denied.body).not.toContain("ov_live_server");
  });
});

describe("createHandler", () => {
  it("serves the plugin page and proxies capture", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ov-front-"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Overturn</title>");
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const handler = createHandler({
      apiKey: "ov_live_server",
      baseUrl: "https://api.overturn.run",
      root: dir,
      fetchImpl,
    });

    const page = await invoke(handler, { method: "GET", url: "/" });
    expect(page.status).toBe(200);
    expect(page.body.toString()).toContain("Overturn");

    const capture = await invoke(handler, {
      method: "POST",
      url: "/v1/capture",
      headers: { origin: "https://plugin.example", "content-type": "application/json" },
      body: JSON.stringify({ source: "front" }),
    });
    expect(capture.status).toBe(200);
    expect(JSON.parse(capture.body.toString())).toEqual({ ok: true });
  });
});

function invoke(
  handler: (req: unknown, res: unknown) => Promise<void>,
  input: { method: string; url: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = {
      method: input.method,
      url: input.url,
      headers: input.headers ?? {},
      on(event: string, cb: (chunk?: Buffer) => void) {
        if (event === "data" && input.body) queueMicrotask(() => cb(Buffer.from(input.body ?? "")));
        if (event === "end") queueMicrotask(() => cb());
        return req;
      },
      destroy() {},
    };
    const res = {
      statusCode: 0,
      chunks: [] as Buffer[],
      writeHead(code: number) {
        this.statusCode = code;
      },
      end(body?: unknown) {
        if (body !== undefined) this.chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
        resolve({ status: this.statusCode, body: Buffer.concat(this.chunks) });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}
