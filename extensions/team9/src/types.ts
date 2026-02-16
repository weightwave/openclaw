/**
 * Team9 Channel Plugin Types
 */

// ==================== Token Types ====================

/** Source from which the bot access token was resolved */
export type Team9TokenSource = "env" | "config" | "none";

// ==================== Configuration Types ====================

export type Team9AccountConfig = {
  /** Account identifier */
  accountId: string;
  /** Display name for this account */
  name?: string;
  /** Whether this account is enabled */
  enabled?: boolean;
  /** Team9 server base URL (from TEAM9_BASE_URL env var) */
  baseUrl: string;
  /** Team9 WebSocket URL (derived from baseUrl if not set) */
  wsUrl?: string;
  /** Authentication credentials */
  credentials?: {
    /** Bot access token (from TEAM9_TOKEN env var) */
    token: string;
  };
  /** DM policy configuration */
  dm?: {
    policy?: "pairing" | "allowlist" | "open" | "disabled";
    allowFrom?: string[];
  };
  /** Allowed channels */
  channels?: {
    allowlist?: string[];
  };
  /** Per-channel group configuration. Key is channel ID or "*" for default. */
  groups?: Record<string, Team9GroupConfig>;
};

/** Per-channel group mention configuration */
export type Team9GroupConfig = {
  /** Require mentioning the bot to trigger replies in this channel. Default: true. */
  requireMention?: boolean;
};

export type Team9Config = {
  enabled?: boolean;
  /** Server base URL (from TEAM9_BASE_URL env var) */
  baseUrl?: string;
  /** WebSocket URL (derived from baseUrl if not set) */
  wsUrl?: string;
  /** Authentication credentials */
  credentials?: {
    /** Bot access token (from TEAM9_TOKEN env var) */
    token: string;
  };
  /** Multiple accounts */
  accounts?: Record<string, Team9AccountConfig>;
  /** DM policy */
  dm?: {
    policy?: "pairing" | "allowlist" | "open" | "disabled";
    allowFrom?: string[];
  };
  /** Per-channel group configuration. Key is channel ID or "*" for default. */
  groups?: Record<string, Team9GroupConfig>;
};

export type ResolvedTeam9Account = {
  accountId: string;
  name?: string;
  enabled: boolean;
  baseUrl: string;
  wsUrl: string;
  /** Bot access token for authentication */
  token?: string;
  /** Where the token was resolved from */
  tokenSource: Team9TokenSource;
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom: string[];
  channelAllowlist: string[];
};

// ==================== API Types ====================

export type Team9User = {
  id: string;
  username: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string;
  isOnline?: boolean;
};

export type Team9Channel = {
  id: string;
  name: string;
  type: "direct" | "public" | "private";
  description?: string;
  tenantId?: string;
  createdAt: string;
  updatedAt: string;
};

export type Team9MessageAttachment = {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
};

export type Team9Message = {
  id: string;
  channelId: string;
  senderId: string;
  content: string;
  type: "text" | "file" | "system";
  parentId?: string;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
  sender?: Team9User;
  attachments?: Team9MessageAttachment[];
  reactions?: Array<{
    emoji: string;
    count: number;
    users: string[];
  }>;
};

export type CreateMessageDto = {
  content: string;
  parentId?: string;
  attachments?: Array<{
    fileName: string;
    fileSize: number;
    mimeType: string;
    url: string;
  }>;
  metadata?: Record<string, unknown>;
  /** Skip WebSocket broadcast (used during streaming to avoid duplicate new_message) */
  skipBroadcast?: boolean;
};

// ==================== WebSocket Event Types ====================

export type Team9WsEvents = {
  // Auth events
  authenticated: { userId: string };
  auth_error: { message: string };

  // Channel events
  join_channel: { channelId: string };
  leave_channel: { channelId: string };
  channel_joined: { channelId: string; userId: string; username: string };
  channel_left: { channelId: string; userId: string };

  // Message events
  new_message: Team9Message;
  message_updated: Team9Message;
  message_deleted: { messageId: string };

  // Read status
  mark_as_read: { channelId: string; messageId: string };
  read_status_updated: { channelId: string; userId: string; lastReadMessageId: string };

  // Typing events
  typing_start: { channelId: string };
  typing_stop: { channelId: string };
  user_typing: { channelId: string; userId: string; username?: string; isTyping: boolean };

  // User status
  user_online: { userId: string; username?: string; workspaceId?: string };
  user_offline: { userId: string; workspaceId?: string };

  // Reactions
  reaction_added: { messageId: string; userId: string; emoji: string };
  reaction_removed: { messageId: string; userId: string; emoji: string };

  // System
  ping: { timestamp: number };
  pong: { timestamp: number; serverTime: number };
};

// ==================== OpenClaw Integration Types ====================

export type Team9IncomingMessage = {
  channel: "team9";
  accountId: string;
  messageId: string;
  channelId: string;
  senderId: string;
  senderName?: string;
  content: string;
  timestamp: Date;
  parentId?: string;
  attachments?: Team9MessageAttachment[];
  isGroup: boolean;
};

export type Team9OutgoingMessage = {
  to: string; // channelId or user:userId
  text: string;
  accountId?: string;
  replyToId?: string;
  mediaUrl?: string;
};
