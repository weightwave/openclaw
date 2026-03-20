import type { VerboseLevel } from "../auto-reply/thinking.js";

export type AgentEventStream = "lifecycle" | "tool" | "assistant" | "error" | (string & {});

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
  metadata?: Record<string, unknown>;
};

export type AgentRunContext = {
  sessionKey?: string;
  verboseLevel?: VerboseLevel;
  isHeartbeat?: boolean;
  metadata?: Record<string, unknown>;
};

// ── Shared state (globalThis singleton) ──────────────────────────────
// Uses Symbol.for() so that both Node.js ESM and jiti loaders resolve
// to the exact same state object, preventing duplicate listener sets.
// Same pattern as plugins/runtime.ts (line 19).

const AGENT_EVENTS_STATE = Symbol.for("openclaw.agentEventsState.v1");

type AgentEventsState = {
  seqByRun: Map<string, number>;
  listeners: Set<(evt: AgentEventPayload) => void>;
  runContextById: Map<string, AgentRunContext>;
};

const state: AgentEventsState = (() => {
  const g = globalThis as typeof globalThis & {
    [AGENT_EVENTS_STATE]?: AgentEventsState;
  };
  if (!g[AGENT_EVENTS_STATE]) {
    g[AGENT_EVENTS_STATE] = {
      seqByRun: new Map(),
      listeners: new Set(),
      runContextById: new Map(),
    };
  }
  return g[AGENT_EVENTS_STATE];
})();

// ── Public API (unchanged) ───────────────────────────────────────────

export function registerAgentRunContext(runId: string, context: AgentRunContext) {
  if (!runId) return;
  const existing = state.runContextById.get(runId);
  if (!existing) {
    state.runContextById.set(runId, { ...context });
    return;
  }
  if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
    existing.sessionKey = context.sessionKey;
  }
  if (context.verboseLevel && existing.verboseLevel !== context.verboseLevel) {
    existing.verboseLevel = context.verboseLevel;
  }
  if (context.isHeartbeat !== undefined && existing.isHeartbeat !== context.isHeartbeat) {
    existing.isHeartbeat = context.isHeartbeat;
  }
  if (context.metadata !== undefined) existing.metadata = context.metadata;
}

export function getAgentRunContext(runId: string) {
  return state.runContextById.get(runId);
}

export function clearAgentRunContext(runId: string) {
  state.runContextById.delete(runId);
}

/**
 * Reset all shared state for testing. Clears seqByRun, listeners, and
 * runContextById so tests don't leak state across cases.
 */
export function resetAgentRunContextForTest() {
  state.seqByRun.clear();
  state.listeners.clear();
  state.runContextById.clear();
}

export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  const nextSeq = (state.seqByRun.get(event.runId) ?? 0) + 1;
  state.seqByRun.set(event.runId, nextSeq);
  const context = state.runContextById.get(event.runId);
  const sessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim()
      ? event.sessionKey
      : context?.sessionKey;
  const enriched: AgentEventPayload = {
    ...event,
    sessionKey,
    metadata: context?.metadata,
    seq: nextSeq,
    ts: Date.now(),
  };
  for (const listener of state.listeners) {
    try {
      listener(enriched);
    } catch {
      /* ignore */
    }
  }
}

export function onAgentEvent(listener: (evt: AgentEventPayload) => void) {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}
