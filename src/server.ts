import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { predictNextTurn } from "./predictor.ts";
import { HttpError, validatePredictRequest } from "./validation.ts";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const MAX_BODY_BYTES = 1_000_000;

const server = createServer(async (request, response) => {
  setHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method !== "POST" || request.url !== "/v1/predict") {
    writeJson(response, 404, { error: "not_found", details: "Use POST /v1/predict." });
    return;
  }

  try {
    const rawBody = await readBody(request);
    const input = validatePredictRequest(JSON.parse(rawBody) as unknown);
    const prediction = await predictNextTurn(input);
    writeJson(response, 200, prediction);
  } catch (error) {
    if (error instanceof SyntaxError) {
      writeJson(response, 400, { error: "invalid_json", details: "Request body must be valid JSON." });
      return;
    }
    if (error instanceof HttpError) {
      writeJson(response, error.statusCode, { error: error.message, details: error.details });
      return;
    }
    writeJson(response, 500, { error: "internal_error", details: "Unexpected prediction service error." });
  }
});

server.requestTimeout = 60_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

server.listen(PORT, HOST, () => {
  console.log(`Negotiation predictor listening on http://${HOST}:${PORT}`);
});

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "body_too_large", `Request body exceeds ${MAX_BODY_BYTES} bytes.`));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function setHeaders(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
}
