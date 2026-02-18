/**
 * Team9 Channel Plugin
 *
 * Implements the ChannelPlugin interface for Team9 integration.
 *
 * Agent routing is handled by the core framework via resolveAgentRoute().
 * By default all messages go to the default agent. Use `openclaw agent add --bind team9`
 * to route Team9 messages to a dedicated agent with its own workspace.
 */

import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk";
import type { ResolvedTeam9Account, Team9Config, Team9OutboundAttachment } from "./types.js";
import {
  listTeam9AccountIds,
  resolveTeam9Account,
  getDefaultTeam9AccountId,
  isTeam9AccountConfigured,
  describeTeam9Account,
  applyTeam9AccountConfig,
} from "./config.js";
import { getTeam9Runtime } from "./runtime.js";
import { Team9ApiClient, Team9AuthError } from "./api-client.js";
import { createTeam9WsClient } from "./websocket-client.js";
import type { Team9WebSocketClient } from "./websocket-client.js";
import { team9OnboardingAdapter } from "./onboarding.js";
import { resolveTeam9GroupRequireMention } from "./group-mentions.js";
import { uploadMediaToTeam9 } from "./media.js";
import { createTeam9MonitorContext } from "./monitor/context.js";
import type { Team9MonitorContext } from "./monitor/context.js";
import { createTeam9MessageHandler } from "./monitor/message-handler.js";

// Store active connections per account (with monitor context)
const activeConnections = new Map<
  string,
  {
    api: Team9ApiClient;
    ws: Team9WebSocketClient;
    monitorCtx: Team9MonitorContext;
  }
>();

// ==================== Connection Watchdog ====================

let watchdogInterval: NodeJS.Timeout | null = null;
const watchdogFailures = new Map<string, number>();

function startWatchdog(): void {
  if (watchdogInterval) return;

  watchdogInterval = setInterval(() => {
    for (const [accountId, conn] of activeConnections) {
      const active = conn.ws.isActive();
      const healthy = conn.ws.isHealthy();

      if (active && healthy) {
        watchdogFailures.delete(accountId);
        continue;
      }

      const failures = (watchdogFailures.get(accountId) ?? 0) + 1;
      watchdogFailures.set(accountId, failures);

      const lastActivity = conn.ws.getLastActivityAt();
      const agoSec = lastActivity > 0 ? Math.round((Date.now() - lastActivity) / 1000) : -1;
      console.warn(
        `[Team9 Watchdog] Account ${accountId} unhealthy ` +
          `(active=${active}, healthy=${healthy}, lastActivity=${agoSec}s ago, failures=${failures})`,
      );

      if (failures >= 3) {
        // 3 consecutive failures (~3 minutes) — tear down and rebuild
        console.error(
          `[Team9 Watchdog] Account ${accountId}: ${failures} consecutive failures, rebuilding connection`,
        );
        watchdogFailures.delete(accountId);

        // Rebuild in the background
        void (async () => {
          try {
            conn.ws.disconnect();
            activeConnections.delete(accountId);
            const runtime = getTeam9Runtime();
            const cfg = runtime.config.loadConfig();
            const account = resolveTeam9Account({ cfg, accountId });
            await getConnection(account, cfg);
            console.log(`[Team9 Watchdog] Account ${accountId} reconnected successfully`);
          } catch (err) {
            console.error(`[Team9 Watchdog] Failed to rebuild connection for ${accountId}:`, err);
          }
        })();
      }
    }
  }, 60_000); // Check every 60 seconds
}

function stopWatchdog(): void {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
  watchdogFailures.clear();
}

/**
 * Get or create connection for an account.
 * Used by outbound methods (sendText, sendMedia, actions).
 */
async function getConnection(account: ResolvedTeam9Account, cfg: OpenClawConfig) {
  const existing = activeConnections.get(account.accountId);
  if (existing && existing.ws.isActive()) {
    return existing;
  }

  if (!account.token) {
    throw new Error("No token available for Team9 connection. Set TEAM9_TOKEN env var.");
  }

  const api = new Team9ApiClient(account.baseUrl, account.token);

  // Create monitor context (botUserId/botUsername set during onAuthenticated)
  const monitorCtx = createTeam9MonitorContext({
    account,
    api,
    ws: null as unknown as Team9WebSocketClient, // set after ws creation
    cfg,
  });

  // Create debouncer-based message handler
  const messageHandler = createTeam9MessageHandler(monitorCtx);

  const ws = createTeam9WsClient(
    { ...account, token: account.token },
    {
      onMessage: messageHandler,
      onConnect: () => {
        console.log(`[Team9] WebSocket connected for account: ${account.accountId}`);
      },
      onAuthenticated: async (userId) => {
        monitorCtx.botUserId = userId;
        console.log(`[Team9] Bot user ID set to: ${userId}`);

        // Fetch bot user profile for mention detection in group messages
        try {
          const me = await api.getMe();
          monitorCtx.botUsername = me.username ?? null;
          console.log(`[Team9] Bot username: ${me.username}, displayName: ${me.displayName ?? "none"}`);
        } catch (err) {
          console.warn(`[Team9] Failed to fetch bot user profile, mention detection may be limited:`, err);
        }

        // Join all existing channels to receive messages
        try {
          const channels = await api.getUserChannels();
          console.log(`[Team9] Joining ${channels.length} existing channels...`);
          for (const channel of channels) {
            console.log(`[Team9]   -> channel: ${channel.id} type=${channel.type} name=${channel.name}`);
            ws.setChannelType(channel.id, channel.type);
            ws.joinChannel(channel.id);
          }
          console.log(`[Team9] Joined all channels successfully`);

          // Cache tenantId from channel metadata for file API operations
          if (!api.getTenantId()) {
            const firstWithTenant = channels.find((ch) => ch.tenantId);
            if (firstWithTenant?.tenantId) {
              api.setTenantId(firstWithTenant.tenantId);
              console.log(`[Team9] Cached tenantId: ${firstWithTenant.tenantId}`);
            }
          }
        } catch (err) {
          console.error(`[Team9] Failed to join existing channels:`, err);
        }
      },
      onChannelJoined: async (channelId) => {
        try {
          const channel = await api.getChannel(channelId);
          ws.setChannelType(channel.id, channel.type);
          console.log(`[Team9] Cached channel type for ${channelId}: ${channel.type}`);
        } catch (err) {
          console.error(`[Team9] Failed to fetch channel metadata for ${channelId}:`, err);
        }
      },
      onDisconnect: (reason) => {
        console.log(`[Team9] WebSocket disconnected: ${reason}`);
      },
      onError: (error) => {
        console.error(`[Team9] WebSocket error:`, error);
      },
    }
  );

  // Complete the monitor context with the ws reference
  monitorCtx.ws = ws;

  try {
    await ws.connect();
  } catch (err) {
    if (err instanceof Team9AuthError) {
      console.error(
        `[Team9] Authentication failed for account ${account.accountId}. ` +
        `Token source: ${account.tokenSource}. ` +
        `Verify your bot access token is valid and not revoked.`,
      );
    }
    throw err;
  }

  const connection = { api, ws, monitorCtx };
  activeConnections.set(account.accountId, connection);

  // Start the connection watchdog when the first connection is created
  startWatchdog();

  return connection;
}

/**
 * Send a message to Team9
 */
async function sendTeam9Message(
  to: string,
  text: string,
  options?: {
    accountId?: string;
    replyTo?: string;
  }
): Promise<{
  messageId?: string;
  status: "sent" | "failed";
  error?: string;
}> {
  try {
    const runtime = getTeam9Runtime();
    const cfg = runtime.config.loadConfig();
    const account = resolveTeam9Account({
      cfg,
      accountId: options?.accountId,
    });

    if (!isTeam9AccountConfigured(account)) {
      return { status: "failed", error: "Account not configured" };
    }

    const { api } = await getConnection(account, cfg);

    // Parse target: could be channelId or user:userId
    let channelId = to;
    if (to.startsWith("user:")) {
      const userId = to.replace("user:", "");
      const dmChannel = await api.getOrCreateDmChannel(userId);
      channelId = dmChannel.id;
    }

    const message = await api.sendMessage(channelId, {
      content: text,
      parentId: options?.replyTo,
    });

    return { messageId: message.id, status: "sent" };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Team9] Failed to send message:`, errorMessage);
    return { status: "failed", error: errorMessage };
  }
}

/**
 * Team9 Channel Plugin Definition
 */
export const team9Plugin: ChannelPlugin<ResolvedTeam9Account> = {
  id: "team9",

  meta: {
    id: "team9",
    label: "Team9",
    selectionLabel: "Team9 (IM Platform)",
    docsPath: "/channels/team9",
    docsLabel: "team9",
    blurb: "Connect to Team9 instant messaging platform for team collaboration.",
    order: 60,
    quickstartAllowFrom: true,
  },

  onboarding: team9OnboardingAdapter,

  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    polls: false,
    reactions: true,
    threads: true,
    media: true,
    edit: true,
    unsend: true,
  },

  // ==================== Configuration ====================

  config: {
    listAccountIds: (cfg) => listTeam9AccountIds(cfg),

    resolveAccount: (cfg, accountId) =>
      resolveTeam9Account({ cfg, accountId }),

    defaultAccountId: (cfg) => getDefaultTeam9AccountId(cfg),

    isConfigured: (account) => isTeam9AccountConfigured(account),

    describeAccount: (account) => describeTeam9Account(account),

    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const team9Config = cfg.channels?.team9 as Team9Config | undefined;
      if (!team9Config) return cfg;

      if (accountId === "default") {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            team9: {
              ...team9Config,
              enabled,
            },
          },
        };
      }

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          team9: {
            ...team9Config,
            accounts: {
              ...team9Config.accounts,
              [accountId]: {
                ...team9Config.accounts?.[accountId],
                enabled,
              },
            },
          },
        },
      };
    },

    deleteAccount: ({ cfg, accountId }) => {
      const team9Config = cfg.channels?.team9 as Team9Config | undefined;
      if (!team9Config?.accounts) return cfg;

      const { [accountId]: _, ...remainingAccounts } = team9Config.accounts;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          team9: {
            ...team9Config,
            accounts: remainingAccounts,
          },
        },
      };
    },
  },

  // ==================== Groups (mention gating) ====================

  groups: {
    resolveRequireMention: resolveTeam9GroupRequireMention,
  },

  // ==================== Security ====================

  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.dmPolicy,
      allowFrom: account.allowFrom,
      allowFromPath: `channels.team9.dm.allowFrom`,
      approveHint: "Add user ID to allowFrom list in config",
    }),
  },

  // ==================== Setup ====================

  setup: {
    validateInput: ({ input }) => {
      if (!input.url && !input.token) {
        return "Team9 requires a server URL and bot token";
      }
      return null;
    },

    applyAccountConfig: ({ cfg, accountId, input }) =>
      applyTeam9AccountConfig({ cfg, accountId, input: { baseUrl: input.url, token: input.token } }),
  },

  // ==================== Message Sending ====================

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    chunker: null,

    sendText: async ({ to, text, accountId, replyToId }) => {
      const result = await sendTeam9Message(to, text, {
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      });
      return {
        channel: "team9" as const,
        messageId: result.messageId ?? "",
        status: result.status,
        error: result.error,
      };
    },

    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId }) => {
      try {
        const runtime = getTeam9Runtime();
        const cfg = runtime.config.loadConfig();
        const account = resolveTeam9Account({
          cfg,
          accountId: accountId ?? undefined,
        });

        if (!isTeam9AccountConfigured(account)) {
          return { channel: "team9" as const, messageId: "", status: "failed" as const, error: "Account not configured" };
        }

        const { api } = await getConnection(account, cfg);

        let channelId = to;
        if (to.startsWith("user:")) {
          const userId = to.replace("user:", "");
          const dmChannel = await api.getOrCreateDmChannel(userId);
          channelId = dmChannel.id;
        }

        let attachments: Team9OutboundAttachment[] | undefined;

        if (mediaUrl) {
          try {
            const media = await runtime.media.loadWebMedia(mediaUrl);
            const fileName = media.fileName ?? "upload";
            const contentType = media.contentType ?? "application/octet-stream";

            const attachment = await uploadMediaToTeam9(api, {
              buffer: media.buffer,
              fileName,
              contentType,
              channelId,
            });
            attachments = [attachment];
          } catch (err) {
            console.error(`[Team9] Failed to upload media, falling back to URL in text: ${String(err)}`);
            text = mediaUrl ? `${text}\n\n${mediaUrl}` : text;
          }
        }

        const message = await api.sendMessage(channelId, {
          content: text || "",
          parentId: replyToId ?? undefined,
          attachments,
        });

        return {
          channel: "team9" as const,
          messageId: message.id,
          status: "sent" as const,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[Team9] Failed to send media message:`, errorMessage);
        return {
          channel: "team9" as const,
          messageId: "",
          status: "failed" as const,
          error: errorMessage,
        };
      }
    },
  },

  // ==================== Threading ====================

  threading: {
    resolveReplyToMode: ({ cfg }) => {
      return "first";
    },
  },

  // ==================== Messaging Target ====================

  messaging: {
    normalizeTarget: (target) => {
      if (target.startsWith("user:") || target.startsWith("channel:")) {
        return target;
      }
      return target;
    },

    targetResolver: {
      looksLikeId: (id) => {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id
        );
      },
      hint: "<channelId|user:userId>",
    },
  },

  // ==================== Actions ====================

  actions: {
    listActions: () => {
      return ["send", "edit", "delete", "react"];
    },

    handleAction: async ({ action, params, cfg, accountId }) => {
      const account = resolveTeam9Account({ cfg, accountId });
      const { api } = await getConnection(account, cfg);

      if (action === "edit") {
        const messageId = readStringParam(params, "messageId", { required: true, label: "messageId" });
        const text = readStringParam(params, "text", { required: true, label: "text" });
        await api.updateMessage(messageId, text);
        return jsonResult({ ok: true, edited: messageId });
      }

      if (action === "delete") {
        const messageId = readStringParam(params, "messageId", { required: true, label: "messageId" });
        await api.deleteMessage(messageId);
        return jsonResult({ ok: true, deleted: messageId });
      }

      if (action === "react") {
        const messageId = readStringParam(params, "messageId", { required: true, label: "messageId" });
        const emoji = readStringParam(params, "emoji", { required: true, label: "emoji" });
        const remove = typeof params.remove === "boolean" ? params.remove : false;

        if (remove) {
          await api.removeReaction(messageId, emoji);
          return jsonResult({ ok: true, removed: emoji });
        }

        await api.addReaction(messageId, emoji);
        return jsonResult({ ok: true, added: emoji });
      }

      throw new Error(`Action ${action} not supported for team9.`);
    },
  },

  // ==================== Gateway Lifecycle ====================

  gateway: {
    startAccount: async ({ account, cfg }) => {
      if (!isTeam9AccountConfigured(account)) {
        console.log(`[Team9] Account ${account.accountId} not configured, skipping`);
        return;
      }

      if (!account.enabled) {
        console.log(`[Team9] Account ${account.accountId} disabled, skipping`);
        return;
      }

      console.log(`[Team9] Starting account: ${account.accountId} (token source: ${account.tokenSource})`);

      try {
        await getConnection(account, cfg);
        console.log(`[Team9] Account ${account.accountId} started successfully`);
      } catch (error) {
        console.error(
          `[Team9] Failed to start account ${account.accountId}:`,
          error
        );
        throw error;
      }
    },

    stopAccount: async ({ account }) => {
      const connection = activeConnections.get(account.accountId);
      if (connection) {
        connection.ws.disconnect();
        activeConnections.delete(account.accountId);
        watchdogFailures.delete(account.accountId);
        console.log(`[Team9] Account ${account.accountId} stopped`);
      }

      // Stop the watchdog when no connections remain
      if (activeConnections.size === 0) {
        stopWatchdog();
      }
    },
  },

  // ==================== Status ====================

  status: {
    probeAccount: async ({ account }) => {
      if (!isTeam9AccountConfigured(account)) {
        return { status: "not_configured" };
      }

      const connection = activeConnections.get(account.accountId);
      if (!connection) {
        return { status: "disconnected" };
      }

      const active = connection.ws.isActive();
      const healthy = connection.ws.isHealthy();
      return {
        status: active && healthy ? "connected" : "disconnected",
        baseUrl: account.baseUrl,
      };
    },

    buildAccountSnapshot: async ({ account, cfg }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: isTeam9AccountConfigured(account),
      connected: activeConnections.get(account.accountId)?.ws.isActive() ?? false,
      tokenSource: account.tokenSource,
    }),
  },
};
