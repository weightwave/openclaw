/**
 * Team9 Plugin Runtime
 *
 * Manages the runtime state and provides access to OpenClaw APIs
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setTeam9Runtime(next: PluginRuntime): void {
  runtime = next;
}

export function getTeam9Runtime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Team9 runtime not initialized");
  }
  return runtime;
}

export function hasTeam9Runtime(): boolean {
  return runtime !== null;
}
