/**
 * Team9 Channel Plugin for OpenClaw
 *
 * This plugin enables OpenClaw to send and receive messages through Team9,
 * an instant messaging platform for team collaboration.
 *
 * Features:
 * - Direct messages and group channels
 * - Message threading
 * - Reactions
 * - Real-time updates via WebSocket
 *
 * Configuration:
 * ```yaml
 * channels:
 *   team9:
 *     enabled: true
 *     baseUrl: "http://localhost:3000"
 *     token: "your-jwt-token"
 *     # OR use credentials
 *     credentials:
 *       username: "bot-user"
 *       password: "bot-password"
 *     workspaceId: "your-workspace-id"
 *     dm:
 *       policy: "pairing"  # or "allow", "deny"
 *       allowFrom: ["user-id-1", "user-id-2"]
 * ```
 *
 * Environment Variables:
 * - TEAM9_BASE_URL: Server base URL
 * - TEAM9_WS_URL: WebSocket URL (optional, derived from baseUrl)
 * - TEAM9_TOKEN: JWT token for authentication
 * - TEAM9_WORKSPACE_ID: Default workspace ID
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { team9Plugin } from "./src/channel.js";
import { setTeam9Runtime } from "./src/runtime.js";

const plugin = {
  id: "team9",
  name: "Team9",
  description: "Team9 instant messaging platform integration",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // Store runtime reference for use by channel implementation
    setTeam9Runtime(api.runtime);

    // Register the channel plugin
    api.registerChannel({ plugin: team9Plugin });

    console.log("[Team9 Plugin] Registered successfully");
  },
};

export default plugin;
