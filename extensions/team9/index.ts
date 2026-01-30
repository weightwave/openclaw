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
 * Configuration is primarily via environment variables:
 * - TEAM9_BASE_URL: Server base URL (required)
 * - TEAM9_TOKEN: JWT token for authentication (required)
 * - TEAM9_WS_URL: WebSocket URL (optional, derived from baseUrl)
 *
 * Optional config file settings:
 * ```yaml
 * channels:
 *   team9:
 *     enabled: true
 *     dm:
 *       policy: "allow"  # or "deny", "pairing"
 * ```
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
