/**
 * Task Event Bridge
 *
 * Listens to OpenClaw agent events and translates them into Team9 Bot API
 * calls. Only processes events where metadata.source === 'team9-task'.
 */

import {
  onAgentEvent,
  type AgentEventPayload,
} from "openclaw/plugin-sdk";

type TaskRunState = {
  taskId: string;
  executionId: string;
  stepIndex: number;
  currentToolName?: string;
};

type TaskMetadata = {
  source: string;
  taskId: string;
  executionId: string;
};

const RETRY_DELAY_MS = 1000;

async function callBotApi(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/bot/tasks${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      console.error(`[task-bridge] Bot API ${method} ${path} failed: ${res.status} ${res.statusText}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[task-bridge] Bot API ${method} ${path} error:`, err);
    return false;
  }
}

async function callBotApiWithRetry(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<void> {
  const ok = await callBotApi(baseUrl, token, method, path, body);
  if (!ok) {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    await callBotApi(baseUrl, token, method, path, body);
  }
}

function handleTaskEvent(
  runStates: Map<string, TaskRunState>,
  metadata: TaskMetadata,
  event: AgentEventPayload,
  baseUrl: string,
  token: string,
): void {
  const { taskId } = metadata;
  const { runId, data } = event;
  const stream = event.stream;
  const phase = data?.phase as string | undefined;

  // Initialize run state on first event
  if (!runStates.has(runId)) {
    runStates.set(runId, {
      taskId: metadata.taskId,
      executionId: metadata.executionId,
      stepIndex: 0,
    });
  }

  const state = runStates.get(runId)!;

  if (stream === "lifecycle") {
    if (phase === "start") {
      return; // No-op — task is already in_progress
    }

    if (phase === "end") {
      void callBotApiWithRetry(baseUrl, token, "PATCH", `/${taskId}/executions/${state.executionId}/status`, {
        status: "completed",
      });
      runStates.delete(runId);
      return;
    }

    if (phase === "error") {
      const errorMessage =
        typeof data?.error === "string"
          ? data.error
          : typeof data?.message === "string"
            ? data.message
            : "Agent execution failed";

      void callBotApiWithRetry(baseUrl, token, "PATCH", `/${taskId}/executions/${state.executionId}/status`, {
        status: "failed",
        error: { message: errorMessage },
      });
      runStates.delete(runId);
      return;
    }
  }

  if (stream === "tool") {
    if (phase === "start") {
      const toolName = (data?.name as string) || "tool";
      state.stepIndex += 1;
      state.currentToolName = toolName;

      void callBotApi(baseUrl, token, "POST", `/${taskId}/executions/${state.executionId}/steps`, {
        steps: [
          {
            orderIndex: state.stepIndex,
            title: toolName,
            status: "in_progress",
          },
        ],
      });
      return;
    }

    if (phase === "result") {
      const toolName = state.currentToolName || "tool";
      const failed = data?.isError === true;

      void callBotApi(baseUrl, token, "POST", `/${taskId}/executions/${state.executionId}/steps`, {
        steps: [
          {
            orderIndex: state.stepIndex,
            title: toolName,
            status: failed ? "failed" : "completed",
          },
        ],
      });
      state.currentToolName = undefined;
      return;
    }
  }
}

export function startTaskBridge(baseUrl: string, token: string): () => void {
  const runStates = new Map<string, TaskRunState>();

  const unsubscribe = onAgentEvent((event: AgentEventPayload) => {
    const metadata = event.metadata;
    if (!metadata) return;
    if (metadata.source !== "team9-task") return;

    handleTaskEvent(
      runStates,
      metadata as TaskMetadata,
      event,
      baseUrl,
      token,
    );
  });

  console.log("[task-bridge] Task event bridge started");
  return unsubscribe;
}
