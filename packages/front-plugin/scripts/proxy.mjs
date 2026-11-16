// Same-origin host for the Front plugin iframe: static files + a narrow reverse proxy
// that attaches the Overturn project key server-side.
//
//   OVERTURN_API_KEY=ov_live_… node scripts/proxy.mjs --root dist/app --port 8787

import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_BODY_BYTES = 1024 * 1024;
export const ALLOWED = new Map([
  ["POST", new Set(["/v1/capture"])],
  ["GET", new Set(["/v1/runs"])],
]);

/**
 * @param {string} urlPath
 * @param {string} method
 */
export function allowedApiPath(method, urlPath) {
  const allowed = ALLOWED.get(method.toUpperCase());
  if (!allowed) return false;
  const pathOnly = urlPath.split("?")[0] ?? urlPath;
  return allowed.has(pathOnly);
}

/**
 * @param {string} raw
 * @param {number} max
 */
export function assertBodySize(raw, max = MAX_BODY_BYTES) {
  if (Buffer.byteLength(raw, "utf8") > max) {
    const err = new Error("payload too large");
    err.status = 413;
    throw err;
  }
}

/**
 * @param {{ method: string, url?: string, headers?: Record<string, string | string[] | undefined> }} req
 * @param {Buffer | string} rawBody
 * @param {{ baseUrl: string, apiKey: string, fetchImpl?: typeof fetch }} opts
 */
export async function forwardApi(req, rawBody, opts) {
  const method = (req.method ?? "GET").toUpperCase();
  const urlPath = req.url ?? "/";
  if (method === "OPTIONS") {
    return { status: 204, headers: corsHeaders(req, true), body: "" };
  }
  if (!allowedApiPath(method, urlPath)) {
    return { status: 404, headers: corsHeaders(req, false), body: "not found" };
  }
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  assertBodySize(body);
  const target = `${opts.baseUrl.replace(/\/+$/, "")}${urlPath}`;
  const headers = { Accept: "application/json", Authorization: `Bearer ${opts.apiKey}` };
  if (method !== "GET" && method !== "HEAD") headers["Content-Type"] = "application/json";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(target, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });
  const text = await res.text();
  const outHeaders = corsHeaders(req, false);
  const ct = res.headers.get("content-type");
  if (ct) outHeaders["content-type"] = ct;
  return { status: res.status, headers: outHeaders, body: text };
}

/**
 * @param {{ headers?: Record<string, string | string[] | undefined> }} req
 * @param {boolean} preflight
 * @returns {Record<string, string>}
 */
export function corsHeaders(req, preflight) {
  const origin = header(req, "origin") ?? "*";
  /** @type {Record<string, string>} */
  const headers = {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  };
  if (preflight) headers["access-control-max-age"] = "600";
  return headers;
}

/**
 * @param {{ headers?: Record<string, string | string[] | undefined> }} req
 * @param {string} name
 */
function header(req, name) {
  const v = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {number} max
 */
export function readBody(req, max = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
        const err = new Error("payload too large");
        err.status = 413;
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

/**
 * @param {string} root
 * @param {string} urlPath
 */
export function safeStaticPath(root, urlPath) {
  const pathOnly = (urlPath.split("?")[0] ?? "/").replace(/\\/g, "/");
  const rel = pathOnly === "/" ? "index.html" : pathOnly.replace(/^\/+/, "");
  const resolved = path.normalize(path.join(root, rel));
  const base = path.normalize(root + path.sep);
  if (resolved !== path.normalize(root) && !resolved.startsWith(base)) return null;
  return resolved;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function parseArgs(argv) {
  const out = { port: 8787, root: "", baseUrl: process.env.OVERTURN_BASE_URL ?? "https://api.overturn.run" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--root") out.root = argv[++i] ?? "";
    else if (a === "--base-url") out.baseUrl = argv[++i] ?? out.baseUrl;
  }
  return out;
}

export function createHandler(opts) {
  const apiKey = opts.apiKey;
  const baseUrl = opts.baseUrl;
  const root = opts.root;
  const fetchImpl = opts.fetchImpl;
  return async (req, res) => {
    try {
      const method = (req.method ?? "GET").toUpperCase();
      const urlPath = req.url ?? "/";
      const pathOnly = urlPath.split("?")[0] ?? "/";
      if (method === "OPTIONS" || allowedApiPath(method, pathOnly)) {
        const raw =
          method === "GET" || method === "HEAD" || method === "OPTIONS"
            ? Buffer.alloc(0)
            : await readBody(req);
        const result = await forwardApi(req, raw, { baseUrl, apiKey, fetchImpl });
        send(res, result.status, result.headers, result.body);
        return;
      }
      if (!root || (method !== "GET" && method !== "HEAD")) {
        send(res, 404, { "content-type": "text/plain" }, "not found");
        return;
      }
      const file = safeStaticPath(root, pathOnly);
      if (!file) {
        send(res, 403, { "content-type": "text/plain" }, "forbidden");
        return;
      }
      const stat = statSync(file, { throwIfNoEntry: false });
      const resolved = stat?.isDirectory() ? path.join(file, "index.html") : file;
      const buf = readFileSync(resolved);
      const type = TYPES[path.extname(resolved)] ?? "application/octet-stream";
      send(res, 200, { "content-type": type }, buf);
    } catch (e) {
      const status = e?.status ?? 500;
      const message = status === 413 ? "payload too large" : "proxy error";
      send(res, status, corsHeaders(req, false), message);
    }
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OVERTURN_API_KEY ?? "";
  if (!apiKey) {
    console.error("OVERTURN_API_KEY is required");
    process.exit(1);
  }
  const root = path.resolve(
    args.root || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "app"),
  );
  const server = createServer(createHandler({ apiKey, baseUrl: args.baseUrl, root }));
  server.listen(args.port, () => {
    console.log(`Overturn Front plugin on http://127.0.0.1:${args.port} (key stays on this process)`);
  });
}
