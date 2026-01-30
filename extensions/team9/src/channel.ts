/**
 * Team9 Channel Plugin
 *
 * Implements the ChannelPlugin interface for Team9 integration
 *
 * Session Isolation:
 * Each Team9 user gets their own isolated agent with a separate workspace.
 * This ensures conversation context (IDENTITY.md, SOUL.md, USER.md) is not shared
 * between users. The agentId is generated as `team9-user-{senderId}` and the
 * workspace is automatically created at `~/clawd-team9-user-{senderId}`.
 */

import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedTeam9Account, Team9IncomingMessage } from "./types.js";
import {
  listTeam9AccountIds,
  resolveTeam9Account,
  getDefaultTeam9AccountId,
  isTeam9AccountConfigured,
  describeTeam9Account,
  applyTeam9AccountConfig,
} from "./config.js";
import { getTeam9Runtime } from "./runtime.js";
import { Team9ApiClient } from "./api-client.js";
import { Team9WebSocketClient, createTeam9WsClient } from "./websocket-client.js";
import { team9OnboardingAdapter } from "./onboarding.js";

/**
 * Generate a unique agent ID for a Team9 user.
 * This ensures each user gets their own isolated workspace at ~/clawd-{agentId}.
 *
 * For DM chats: uses senderId to isolate per user
 * For group chats: uses channelId to isolate per group
 */
function generateTeam9AgentId(params: { senderId: string; channelId: string; isGroup: boolean }): string {
  // For group chats, use channelId so all group members share context
  // For DM chats, use senderId so each user has their own context
  const identifier = params.isGroup ? params.channelId : params.senderId;
  // Sanitize to be safe for use in file paths
  const sanitized = identifier.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
  const prefix = params.isGroup ? "team9-group" : "team9-user";
  return `${prefix}-${sanitized}`;
}

/**
 * Build a session key for Team9 with per-user/group agent isolation.
 * Format: agent:{agentId}:team9:{peerKind}:{channelId}
 */
function buildTeam9SessionKey(params: {
  agentId: string;
  channelId: string;
  isGroup: boolean;
}): string {
  const peerKind = params.isGroup ? "group" : "dm";
  return `agent:${params.agentId}:team9:${peerKind}:${params.channelId}`.toLowerCase();
}

// Store current bot user ID to filter out self-messages
let currentBotUserId: string | null = null;

// Store active connections per account
const activeConnections = new Map<
  string,
  {
    api: Team9ApiClient;
    ws: Team9WebSocketClient;
  }
>();

/**
 * Handle incoming message from Team9 and route to OpenClaw agent
 *
 * Uses per-user/group agent isolation to ensure each user has their own
 * workspace and conversation context.
 */
async function handleIncomingMessage(
  message: Team9IncomingMessage,
  account: ResolvedTeam9Account,
  api: Team9ApiClient,
  cfg: OpenClawConfig
): Promise<void> {
  const runtime = getTeam9Runtime();

  // Skip messages from self (the bot)
  if (currentBotUserId && message.senderId === currentBotUserId) {
    return;
  }

  // Strip HTML tags from content for plain text processing
  const plainContent = message.content
    .replace(/<[^>]*>/g, "")
    .trim();

  if (!plainContent) {
    return;
  }

  console.log(`[Team9] Processing message from ${message.senderName}: ${plainContent.substring(0, 50)}...`);

  // Generate per-user/group agent ID for workspace isolation
  // Each user gets their own agent with isolated workspace at ~/clawd-team9-user-{senderId}
  // Each group gets shared agent with workspace at ~/clawd-team9-group-{channelId}
  const agentId = generateTeam9AgentId({
    senderId: message.senderId,
    channelId: message.channelId,
    isGroup: message.isGroup,
  });

  // Build session key with isolated agent
  const sessionKey = buildTeam9SessionKey({
    agentId,
    channelId: message.channelId,
    isGroup: message.isGroup,
  });

  console.log(`[Team9] Session isolation: agentId=${agentId}, sessionKey=${sessionKey}`);

  // Build the message context
  const fromLabel = message.isGroup
    ? `Team9 Channel ${message.channelId}`
    : `Team9 DM from ${message.senderName || message.senderId}`;

  const to = `team9:${message.channelId}`;

  const ctx = runtime.channel.reply.finalizeInboundContext({
    Body: plainContent,
    RawBody: message.content,
    CommandBody: plainContent,
    From: to,
    To: to,
    SessionKey: sessionKey,
    AccountId: account.accountId,
    ChatType: message.isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: message.senderName || "Unknown",
    SenderId: message.senderId,
    Provider: "team9" as const,
    Surface: "team9" as const,
    MessageSid: message.messageId,
    Timestamp: message.timestamp.getTime(),
    CommandAuthorized: true, // Allow commands from Team9
    OriginatingChannel: "team9" as const,
    OriginatingTo: to,
  });

  // Create reply dispatcher that sends responses back to Team9
  const { dispatcher, replyOptions, markDispatchIdle } =
    runtime.channel.reply.createReplyDispatcherWithTyping({
      humanDelay: runtime.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      deliver: async (payload) => {
        // Send reply to Team9
        if (payload.text) {
          try {
            await api.sendMessage(message.channelId, {
              content: payload.text,
              parentId: message.parentId,
            });
          } catch (err) {
            console.error(`[Team9] Failed to send reply:`, err);
          }
        }
      },
      onError: (err, info) => {
        console.error(`[Team9] Reply ${info.kind} failed:`, err);
      },
    });

  // Dispatch the message to the agent
  try {
    await runtime.channel.reply.dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyOptions,
    });
  } catch (err) {
    console.error(`[Team9] Failed to dispatch message:`, err);
  } finally {
    markDispatchIdle();
  }
}

/**
 * Get or create connection for an account
 */
async function getConnection(account: ResolvedTeam9Account, cfg: OpenClawConfig) {
  const existing = activeConnections.get(account.accountId);
  if (existing && existing.ws.isActive()) {
    return existing;
  }

  // Token is required (from env var TEAM9_TOKEN or config)
  if (!account.token) {
    throw new Error("No token available for Team9 connection. Set TEAM9_TOKEN env var.");
  }

  // Create new connection with token
  const api = new Team9ApiClient(account.baseUrl, account.token);
  const token = account.token;

  const ws = createTeam9WsClient(
    { ...account, token },
    {
      onMessage: (message) => {
        // Forward message to OpenClaw agent for processing
        void handleIncomingMessage(message, account, api, cfg);
      },
      onConnect: () => {
        console.log(`[Team9] WebSocket connected for account: ${account.accountId}`);
      },
      onAuthenticated: async (userId) => {
        // Join all existing channels to receive messages
        try {
          const channels = await api.getUserChannels();
          console.log(`[Team9] Joining ${channels.length} existing channels...`);
          for (const channel of channels) {
            ws.joinChannel(channel.id);
          }
          console.log(`[Team9] Joined all channels successfully`);
        } catch (err) {
          console.error(`[Team9] Failed to join existing channels:`, err);
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

  await ws.connect();

  const connection = { api, ws };
  activeConnections.set(account.accountId, connection);
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
    mediaUrl?: string;
  }
): Promise<{
  messageId?: string;
  status: "sent" | "failed";
  error?: string;
}> {
  try {
    const runtime = getTeam9Runtime();
    const cfg = runtime.config.get();
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
      // Get or create DM channel
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

  // Onboarding adapter for `openclaw onboard` wizard
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
      const team9Config = cfg.channels?.team9;
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
      const team9Config = cfg.channels?.team9;
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
      if (!input.baseUrl && !input.token && !input.username) {
        return "Team9 requires either baseUrl+token or credentials (username/password)";
      }
      return null;
    },

    applyAccountConfig: ({ cfg, accountId, input }) =>
      applyTeam9AccountConfig({ cfg, accountId, input }),
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
        channel: "team9",
        ...result,
      };
    },

    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId }) => {
      // For now, just send text with media URL
      // TODO: Implement proper file upload to Team9
      const messageText = mediaUrl ? `${text}\n\n${mediaUrl}` : text;
      const result = await sendTeam9Message(to, messageText, {
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      });
      return {
        channel: "team9",
        ...result,
      };
    },
  },

  // ==================== Threading ====================

  threading: {
    resolveReplyToMode: ({ cfg }) => {
      // Team9 supports threading via parentId
      return "first";
    },
  },

  // ==================== Messaging Target ====================

  messaging: {
    normalizeTarget: (target) => {
      // Support formats: channelId, user:userId, channel:channelId
      if (target.startsWith("user:") || target.startsWith("channel:")) {
        return target;
      }
      // Assume it's a channel ID
      return target;
    },

    targetResolver: {
      looksLikeId: (id) => {
        // Team9 uses UUIDs
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id
        );
      },
      hint: "<channelId|user:userId>",
    },
  },

  // ==================== Actions ====================

  actions: {
    editMessage: async ({ messageId, text, accountId }) => {
      try {
        const runtime = getTeam9Runtime();
        const cfg = runtime.config.get();
        const account = resolveTeam9Account({ cfg, accountId });
        const { api } = await getConnection(account, cfg);

        await api.updateMessage(messageId, text);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    deleteMessage: async ({ messageId, accountId }) => {
      try {
        const runtime = getTeam9Runtime();
        const cfg = runtime.config.get();
        const account = resolveTeam9Account({ cfg, accountId });
        const { api } = await getConnection(account, cfg);

        await api.deleteMessage(messageId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    addReaction: async ({ messageId, emoji, accountId }) => {
      try {
        const runtime = getTeam9Runtime();
        const cfg = runtime.config.get();
        const account = resolveTeam9Account({ cfg, accountId });
        const { api } = await getConnection(account, cfg);

        await api.addReaction(messageId, emoji);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    removeReaction: async ({ messageId, emoji, accountId }) => {
      try {
        const runtime = getTeam9Runtime();
        const cfg = runtime.config.get();
        const account = resolveTeam9Account({ cfg, accountId });
        const { api } = await getConnection(account, cfg);

        await api.removeReaction(messageId, emoji);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
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

      console.log(`[Team9] Starting account: ${account.accountId}`);

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
        console.log(`[Team9] Account ${account.accountId} stopped`);
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

      return {
        status: connection.ws.isActive() ? "connected" : "disconnected",
        baseUrl: account.baseUrl,
      };
    },

    buildAccountSnapshot: async ({ account, cfg }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: isTeam9AccountConfigured(account),
      connected: activeConnections.get(account.accountId)?.ws.isActive() ?? false,
    }),
  },
};
