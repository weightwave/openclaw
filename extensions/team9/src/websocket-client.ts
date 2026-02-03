/**
 * Team9 WebSocket Client
 *
 * Handles real-time communication with Team9 server via Socket.io
 */

import { io, Socket } from "socket.io-client";
import type {
  Team9Message,
  Team9WsEvents,
  ResolvedTeam9Account,
  Team9IncomingMessage,
} from "./types.js";

export type Team9MessageHandler = (message: Team9IncomingMessage) => void;

export type Team9WsClientOptions = {
  wsUrl: string;
  token: string;
  accountId: string;
  onMessage?: Team9MessageHandler;
  onConnect?: () => void;
  onAuthenticated?: (userId: string) => void;
  onChannelJoined?: (channelId: string) => void;
  onDisconnect?: (reason: string) => void;
  onError?: (error: Error) => void;
};

export class Team9WebSocketClient {
  private socket: Socket | null = null;
  private options: Team9WsClientOptions;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private isConnected = false;
  private channelTypes = new Map<string, "direct" | "public" | "private">();

  constructor(options: Team9WsClientOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Connect to Team9 WebSocket with /im namespace
        this.socket = io(this.options.wsUrl, {
          path: "/socket.io",
          transports: ["websocket", "polling"],
          auth: {
            token: this.options.token,
          },
          reconnection: true,
          reconnectionAttempts: this.maxReconnectAttempts,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 5000,
        });

        this.setupEventHandlers();

        // Wait for authentication
        this.socket.once("authenticated", (data: { userId: string }) => {
          console.log(`[Team9 WS] Authenticated as user: ${data.userId}`);
          this.isConnected = true;
          this.startHeartbeat();
          this.options.onConnect?.();
          // Notify about authentication so caller can join existing channels
          this.options.onAuthenticated?.(data.userId);
          resolve();
        });

        this.socket.once("auth_error", (error: { message: string }) => {
          console.error(
            `[Team9 WS] Auth error: ${error.message}. ` +
            `Verify that TEAM9_TOKEN is a valid bot access token (t9bot_...) ` +
            `and has not been revoked.`,
          );
          reject(new Error(`Authentication failed: ${error.message}`));
        });

        this.socket.once("connect_error", (error) => {
          console.error(`[Team9 WS] Connection error:`, error);
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private setupEventHandlers(): void {
    if (!this.socket) return;

    // Debug: log ALL socket.io events to diagnose missing messages
    this.socket.onAny((eventName: string, ...args: unknown[]) => {
      if (eventName === "pong" || eventName === "user_online" || eventName === "user_offline") return;
      const preview = args.length > 0 ? JSON.stringify(args[0]).substring(0, 200) : "";
      console.log(`[Team9 WS DEBUG] Event: ${eventName} ${preview}`);
    });

    // Connection events
    this.socket.on("connect", () => {
      console.log(`[Team9 WS] Connected to server`);
      this.reconnectAttempts = 0;
    });

    this.socket.on("disconnect", (reason) => {
      console.log(`[Team9 WS] Disconnected: ${reason}`);
      this.isConnected = false;
      this.stopHeartbeat();
      this.options.onDisconnect?.(reason);
    });

    this.socket.on("connect_error", (error) => {
      console.error(`[Team9 WS] Connection error:`, error);
      this.reconnectAttempts++;
      this.options.onError?.(error);
    });

    // Channel events - auto-join new channels (e.g., when someone starts a DM)
    this.socket.on("channel_created", (channel: { id: string; name?: string; type?: string }) => {
      console.log(`[Team9 WS] New channel created: ${channel.id} (${channel.type || 'unknown'})`);
      // Cache channel type for isGroup determination
      if (channel.type === "direct" || channel.type === "public" || channel.type === "private") {
        this.channelTypes.set(channel.id, channel.type);
      }
      // Auto-join the channel to receive messages
      this.joinChannel(channel.id);
    });

    // Handle being added to an existing channel (e.g., bot invited to a public channel)
    this.socket.on("channel_joined", (data: { channelId: string; userId: string; username: string }) => {
      console.log(`[Team9 WS] User ${data.username} joined channel: ${data.channelId}`);
      // Auto-join the socket.io room so we receive messages from this channel
      this.joinChannel(data.channelId);
      // Notify caller to fetch and cache channel metadata
      this.options.onChannelJoined?.(data.channelId);
    });

    // Message events
    this.socket.on("new_message", (message: Team9Message) => {
      this.handleIncomingMessage(message);
    });

    this.socket.on("message_updated", (message: Team9Message) => {
      console.log(`[Team9 WS] Message updated: ${message.id}`);
      // Could emit an update event if needed
    });

    this.socket.on("message_deleted", (data: { messageId: string }) => {
      console.log(`[Team9 WS] Message deleted: ${data.messageId}`);
    });

    // Typing events
    this.socket.on(
      "user_typing",
      (data: {
        channelId: string;
        userId: string;
        username?: string;
        isTyping: boolean;
      }) => {
        console.log(
          `[Team9 WS] User ${data.userId} ${data.isTyping ? "started" : "stopped"} typing in ${data.channelId}`
        );
      }
    );

    // User status events
    this.socket.on(
      "user_online",
      (data: { userId: string; username?: string }) => {
        console.log(`[Team9 WS] User online: ${data.userId}`);
      }
    );

    this.socket.on("user_offline", (data: { userId: string }) => {
      console.log(`[Team9 WS] User offline: ${data.userId}`);
    });

    // Reaction events
    this.socket.on(
      "reaction_added",
      (data: { messageId: string; userId: string; emoji: string }) => {
        console.log(
          `[Team9 WS] Reaction ${data.emoji} added to ${data.messageId}`
        );
      }
    );

    this.socket.on(
      "reaction_removed",
      (data: { messageId: string; userId: string; emoji: string }) => {
        console.log(
          `[Team9 WS] Reaction ${data.emoji} removed from ${data.messageId}`
        );
      }
    );

    // Pong response
    this.socket.on("pong", (data: { timestamp: number; serverTime: number }) => {
      const latency = Date.now() - data.timestamp;
      console.log(`[Team9 WS] Pong received, latency: ${latency}ms`);
    });
  }

  private handleIncomingMessage(message: Team9Message): void {
    const incomingMessage: Team9IncomingMessage = {
      channel: "team9",
      accountId: this.options.accountId,
      messageId: message.id,
      channelId: message.channelId,
      senderId: message.senderId,
      senderName: message.sender?.displayName || message.sender?.username,
      content: message.content,
      timestamp: new Date(message.createdAt),
      parentId: message.parentId,
      attachments: message.attachments,
      isGroup: this.channelTypes.get(message.channelId) !== "direct",
    };

    this.options.onMessage?.(incomingMessage);
  }

  private startHeartbeat(): void {
    // Send ping every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      if (this.socket && this.isConnected) {
        this.socket.emit("ping", { timestamp: Date.now() });
      }
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // ==================== Channel Operations ====================

  /**
   * Cache the type of a channel for isGroup determination.
   * Call this after fetching channel metadata from the API.
   */
  setChannelType(channelId: string, type: "direct" | "public" | "private"): void {
    this.channelTypes.set(channelId, type);
  }

  joinChannel(channelId: string): void {
    if (!this.socket || !this.isConnected) {
      console.warn(`[Team9 WS] Cannot join channel: not connected`);
      return;
    }
    this.socket.emit("join_channel", { channelId });
  }

  leaveChannel(channelId: string): void {
    if (!this.socket || !this.isConnected) return;
    this.socket.emit("leave_channel", { channelId });
  }

  // ==================== Typing Status ====================

  startTyping(channelId: string): void {
    if (!this.socket || !this.isConnected) return;
    this.socket.emit("typing_start", { channelId });
  }

  stopTyping(channelId: string): void {
    if (!this.socket || !this.isConnected) return;
    this.socket.emit("typing_stop", { channelId });
  }

  // ==================== Read Status ====================

  markAsRead(channelId: string, messageId: string): void {
    if (!this.socket || !this.isConnected) return;
    this.socket.emit("mark_as_read", { channelId, messageId });
  }

  // ==================== Reactions ====================

  addReaction(messageId: string, emoji: string): void {
    if (!this.socket || !this.isConnected) return;
    this.socket.emit("add_reaction", { messageId, emoji });
  }

  removeReaction(messageId: string, emoji: string): void {
    if (!this.socket || !this.isConnected) return;
    this.socket.emit("remove_reaction", { messageId, emoji });
  }

  // ==================== Connection Management ====================

  disconnect(): void {
    this.stopHeartbeat();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.isConnected = false;
  }

  isActive(): boolean {
    return this.isConnected && this.socket?.connected === true;
  }

  getSocket(): Socket | null {
    return this.socket;
  }
}

// Factory function
export function createTeam9WsClient(
  account: ResolvedTeam9Account,
  handlers: {
    onMessage?: Team9MessageHandler;
    onConnect?: () => void;
    onAuthenticated?: (userId: string) => void;
    onChannelJoined?: (channelId: string) => void;
    onDisconnect?: (reason: string) => void;
    onError?: (error: Error) => void;
  }
): Team9WebSocketClient {
  if (!account.token) {
    throw new Error("Token is required for WebSocket connection");
  }

  return new Team9WebSocketClient({
    wsUrl: account.wsUrl,
    token: account.token,
    accountId: account.accountId,
    ...handlers,
  });
}
