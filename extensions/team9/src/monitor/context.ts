/**
 * Team9 Monitor Context
 *
 * Per-account state container for the Team9 inbound message pipeline.
 * Replaces module-level globals with isolated, per-account state.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedTeam9Account } from "../types.js";
import type { Team9ApiClient } from "../api-client.js";
import type { Team9WebSocketClient } from "../websocket-client.js";

export type Team9MonitorContext = {
  accountId: string;
  account: ResolvedTeam9Account;
  api: Team9ApiClient;
  ws: Team9WebSocketClient;
  cfg: OpenClawConfig;
  // Bot identity — set during onAuthenticated
  botUserId: string | null;
  botUsername: string | null;
};

export function createTeam9MonitorContext(params: {
  account: ResolvedTeam9Account;
  api: Team9ApiClient;
  ws: Team9WebSocketClient;
  cfg: OpenClawConfig;
}): Team9MonitorContext {
  return {
    accountId: params.account.accountId,
    account: params.account,
    api: params.api,
    ws: params.ws,
    cfg: params.cfg,
    botUserId: null,
    botUsername: null,
  };
}
