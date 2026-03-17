// src/gateway/stop-http.ts

import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import {
  sendJson,
  sendUnauthorized,
  sendInvalidRequest,
  sendMethodNotAllowed,
  readJsonBodyOrError,
} from "./http-common.js";
import { getBearerToken } from "./http-utils.js";
import { abortBySessionKey } from "./active-runs.js";

export async function handleStopHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { auth: ResolvedGatewayAuth; trustedProxies?: string[] },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);

  // Match: POST /api/agents/:agentId/stop
  const match = url.pathname.match(/^\/api\/agents\/([^/]+)\/stop$/);
  if (!match) return false;

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  // Auth
  const token = getBearerToken(req);
  const authResult = await authorizeGatewayConnect({
    auth: opts.auth,
    connectAuth: { token, password: token },
    req,
    trustedProxies: opts.trustedProxies,
  });
  if (!authResult.ok) {
    sendUnauthorized(res);
    return true;
  }

  // Read body
  const rawBody = await readJsonBodyOrError(req, res, 64 * 1024); // 64KB max
  if (rawBody === undefined) return true;

  const body = rawBody as { sessionKey?: string };
  if (!body.sessionKey) {
    sendInvalidRequest(res, "Missing required field: sessionKey");
    return true;
  }

  const aborted = abortBySessionKey(body.sessionKey);
  if (aborted) {
    sendJson(res, 200, { status: "stopped" });
  } else {
    sendJson(res, 404, { error: "No active run found for this session" });
  }

  return true;
}
