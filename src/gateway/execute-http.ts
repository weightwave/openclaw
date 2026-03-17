// src/gateway/execute-http.ts

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { agentCommand } from "../commands/agent.js";
import { createDefaultDeps } from "../cli/deps.js";
import { defaultRuntime } from "../runtime.js";
import { registerAgentRunContext } from "../infra/agent-events.js";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import {
  sendJson,
  sendUnauthorized,
  sendInvalidRequest,
  sendMethodNotAllowed,
  readJsonBodyOrError,
} from "./http-common.js";
import { getBearerToken } from "./http-utils.js";
import { registerActiveRun, removeActiveRun } from "./active-runs.js";

// Idempotency cache (10 min TTL)
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const idempotencyCache = new Map<string, { runId: string; acceptedAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of idempotencyCache) {
    if (now - entry.acceptedAt > IDEMPOTENCY_TTL_MS) {
      idempotencyCache.delete(key);
    }
  }
}, 60 * 1000);

type ExecuteRequestBody = {
  message: string;
  idempotencyKey: string;
  sessionKey: string;
  channelId: string;
  timeout?: number;
  extraSystemPrompt?: string;
  task: {
    taskId: string;
    executionId: string;
  };
};

export async function handleExecuteHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { auth: ResolvedGatewayAuth; trustedProxies?: string[] },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);

  // Match: POST /api/agents/:agentId/execute
  const match = url.pathname.match(/^\/api\/agents\/([^/]+)\/execute$/);
  if (!match) return false;

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  // Auth (same pattern as openresponses-http.ts)
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

  const agentId = decodeURIComponent(match[1]!);

  // Read body (1MB max)
  const rawBody = await readJsonBodyOrError(req, res, 1024 * 1024);
  if (rawBody === undefined) return true; // readJsonBodyOrError already sent error

  const body = rawBody as ExecuteRequestBody;

  // Validate required fields
  if (
    !body.message ||
    !body.idempotencyKey ||
    !body.channelId ||
    !body.task?.taskId ||
    !body.task?.executionId
  ) {
    sendInvalidRequest(
      res,
      "Missing required fields: message, idempotencyKey, channelId, task.taskId, task.executionId",
    );
    return true;
  }

  // Idempotency check
  const cached = idempotencyCache.get(body.idempotencyKey);
  if (cached) {
    sendJson(res, 202, { runId: cached.runId, status: "accepted", acceptedAt: cached.acceptedAt });
    return true;
  }

  const runId = randomUUID();
  const acceptedAt = Date.now();
  const sessionKey = body.sessionKey || `agent:${agentId}:task:${body.task.taskId}`;

  // Register run context with task metadata
  registerAgentRunContext(runId, {
    sessionKey,
    metadata: {
      source: "team9-task",
      taskId: body.task.taskId,
      executionId: body.task.executionId,
    },
  });

  // Register active run for stop support
  const abortController = new AbortController();
  registerActiveRun({
    runId,
    sessionKey,
    abortController,
    startedAt: acceptedAt,
  });

  // Fire-and-forget agent execution
  const deps = createDefaultDeps();
  void agentCommand(
    {
      message: body.message,
      agentId,
      sessionKey,
      runId,
      deliver: true,
      channel: "team9",
      messageChannel: "team9",
      to: `team9:${body.channelId}`,
      timeout: body.timeout?.toString(),
      extraSystemPrompt: body.extraSystemPrompt,
      abortSignal: abortController.signal,
    },
    defaultRuntime,
    deps,
  )
    .catch((err: unknown) => {
      console.error(`[execute-http] agentCommand failed for run ${runId}:`, err);
    })
    .finally(() => {
      removeActiveRun(runId);
    });

  // Cache idempotency entry
  idempotencyCache.set(body.idempotencyKey, { runId, acceptedAt });

  // Return 202 immediately
  sendJson(res, 202, { runId, status: "accepted", acceptedAt });
  return true;
}
