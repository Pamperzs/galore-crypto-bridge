/**
 * Node entrypoint wrapping src/worker.js for Render (or any Node host).
 * Converts the incoming Node request into a web-standard Request, runs the
 * Worker fetch handler with process.env, and writes the response back.
 */
import http from "node:http";
import worker from "./src/worker.js";

const port = Number(process.env.PORT || 10000);

function toWebRequest(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const url = `${proto}://${host}${req.url}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, String(value));
  }

  const method = req.method || "GET";
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = req;
    init.duplex = "half";
  }
  return new Request(url, init);
}

const server = http.createServer(async (req, res) => {
  try {
    const webRequest = toWebRequest(req);
    const webResponse = await worker.fetch(webRequest, process.env);
    res.statusCode = webResponse.status;
    webResponse.headers.forEach((value, key) => {
      if (key.toLowerCase() === "content-length") return;
      res.setHeader(key, value);
    });
    const body = Buffer.from(await webResponse.arrayBuffer());
    res.end(body);
  } catch (err) {
    console.error("server: unhandled error", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal error");
    }
  }
});

server.keepAliveTimeout = 30_000;

server.listen(port, () => {
  console.log(`bridge: listening on port ${port}`);
});
