// src/gateway/active-runs.ts

export type ActiveRun = {
  runId: string;
  sessionKey: string;
  abortController: AbortController;
  startedAt: number;
};

const activeRuns = new Map<string, ActiveRun>();
const sessionKeyIndex = new Map<string, string>();

export function registerActiveRun(run: ActiveRun): void {
  activeRuns.set(run.runId, run);
  sessionKeyIndex.set(run.sessionKey, run.runId);
}

export function abortBySessionKey(sessionKey: string): boolean {
  const runId = sessionKeyIndex.get(sessionKey);
  if (!runId) return false;
  const run = activeRuns.get(runId);
  if (!run) return false;
  run.abortController.abort();
  return true;
}

export function removeActiveRun(runId: string): void {
  const run = activeRuns.get(runId);
  if (run) {
    sessionKeyIndex.delete(run.sessionKey);
    activeRuns.delete(runId);
  }
}

// Stale entry cleanup — safety net for runs that never complete
const STALE_THRESHOLD_MS = 25 * 60 * 60 * 1000; // 25 hours

export function startActiveRunsSweep(): NodeJS.Timeout {
  return setInterval(
    () => {
      const now = Date.now();
      for (const [runId, run] of activeRuns) {
        if (now - run.startedAt > STALE_THRESHOLD_MS) {
          removeActiveRun(runId);
        }
      }
    },
    5 * 60 * 1000,
  ); // every 5 minutes
}
