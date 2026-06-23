const http = require("node:http");
const { DEFAULT_LIBRARY_DIR, deleteClip, expandHome, saveClip, updateClip } = require("./store");
const { buildContext } = require("./export-agent-context");
const { recentClips } = require("./search");

const DEFAULT_PORT = 47321;

function json(res, statusCode, payload, origin) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-headers": "content-type,x-knowledge-clips-token",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS"
  };

  if (origin && origin.startsWith("chrome-extension://")) {
    headers["access-control-allow-origin"] = origin;
  }

  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > limit) {
        reject(new Error("request_too_large"));
        req.destroy();
      }
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function isAllowedOrigin(origin) {
  return !origin || origin.startsWith("chrome-extension://");
}

function isAuthorized(req, token) {
  const origin = req.headers.origin || "";
  if (!isAllowedOrigin(origin)) return false;
  if (!token) return true;
  return req.headers["x-knowledge-clips-token"] === token;
}

function createServer(options = {}) {
  const libraryDir = expandHome(options.libraryDir || process.env.KNOWLEDGE_CLIPS_DIR || DEFAULT_LIBRARY_DIR);
  const token = options.token || process.env.KNOWLEDGE_CLIPS_TOKEN || "";

  return http.createServer(async (req, res) => {
    const origin = req.headers.origin || "";

    if (req.method === "OPTIONS") {
      json(res, 204, {}, origin);
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      json(res, 200, {
        ok: true,
        service: "knowledge-clips-helper",
        libraryDir,
        tokenRequired: Boolean(token)
      }, origin);
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/clips")) {
      if (!isAuthorized(req, token)) {
        json(res, 403, { ok: false, error: "forbidden" }, origin);
        return;
      }

      const url = new URL(req.url, "http://127.0.0.1");
      const limit = Math.min(Number(url.searchParams.get("limit") || 12), 50);

      try {
        json(res, 200, {
          ok: true,
          clips: recentClips({ libraryDir, limit })
        }, origin);
      } catch (error) {
        json(res, 400, { ok: false, error: error.message }, origin);
      }
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/agent-context")) {
      if (!isAuthorized(req, token)) {
        json(res, 403, { ok: false, error: "forbidden" }, origin);
        return;
      }

      const url = new URL(req.url, "http://127.0.0.1");
      const query = url.searchParams.get("q") || "";

      try {
        json(res, 200, {
          ok: true,
          markdown: buildContext(query, { libraryDir })
        }, origin);
      } catch (error) {
        json(res, 400, { ok: false, error: error.message }, origin);
      }
      return;
    }

    if (req.method === "POST" && req.url === "/api/clips") {
      if (!isAuthorized(req, token)) {
        json(res, 403, { ok: false, error: "forbidden" }, origin);
        return;
      }

      try {
        const body = await readBody(req);
        const payload = JSON.parse(body);
        const result = saveClip(payload, { libraryDir });
        json(res, 200, { ok: true, ...result }, origin);
      } catch (error) {
        json(res, 400, { ok: false, error: error.message }, origin);
      }
      return;
    }

    if ((req.method === "PATCH" || req.method === "PUT") && req.url.startsWith("/api/clips/")) {
      if (!isAuthorized(req, token)) {
        json(res, 403, { ok: false, error: "forbidden" }, origin);
        return;
      }

      try {
        const id = decodeURIComponent(req.url.replace("/api/clips/", "").split("?")[0]);
        const body = await readBody(req);
        const payload = JSON.parse(body);
        const result = updateClip({ ...payload, id }, { libraryDir });
        json(res, 200, { ok: true, ...result }, origin);
      } catch (error) {
        json(res, 400, { ok: false, error: error.message }, origin);
      }
      return;
    }

    if (req.method === "DELETE" && req.url.startsWith("/api/clips/")) {
      if (!isAuthorized(req, token)) {
        json(res, 403, { ok: false, error: "forbidden" }, origin);
        return;
      }

      try {
        const id = decodeURIComponent(req.url.replace("/api/clips/", "").split("?")[0]);
        const result = deleteClip({ id }, { libraryDir });
        json(res, 200, { ok: true, ...result }, origin);
      } catch (error) {
        json(res, 400, { ok: false, error: error.message }, origin);
      }
      return;
    }

    json(res, 404, { ok: false, error: "not_found" }, origin);
  });
}

if (require.main === module) {
  const port = Number(process.env.KNOWLEDGE_CLIPS_PORT || DEFAULT_PORT);
  const host = "127.0.0.1";
  const server = createServer();

  server.listen(port, host, () => {
    console.log(`Knowledge Clips helper is running at http://${host}:${port}`);
    console.log(`Library directory: ${process.env.KNOWLEDGE_CLIPS_DIR || DEFAULT_LIBRARY_DIR}`);
    if (process.env.KNOWLEDGE_CLIPS_TOKEN) {
      console.log("Token protection: enabled");
    } else {
      console.log("Token protection: disabled; only chrome-extension origins are accepted.");
    }
  });
}

module.exports = {
  createServer,
  isAllowedOrigin,
  isAuthorized
};
