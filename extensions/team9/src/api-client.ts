/**
 * Team9 HTTP API Client
 *
 * Handles REST API communication with Team9 server
 */

import type {
  Team9Channel,
  Team9Message,
  Team9User,
  CreateMessageDto,
  ResolvedTeam9Account,
} from "./types.js";

export class Team9ApiClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, ""); // Remove trailing slash
    this.token = token;
  }

  private async fetch<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };

    headers["Authorization"] = `Bearer ${this.token}`;

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Team9 API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    return response.json() as Promise<T>;
  }

  // ==================== Users ====================

  async getMe(): Promise<Team9User> {
    return this.fetch<Team9User>("/users/me");
  }

  // ==================== Channels ====================

  async getChannels(): Promise<Team9Channel[]> {
    return this.fetch<Team9Channel[]>("/im/channels");
  }

  async getChannel(channelId: string): Promise<Team9Channel> {
    return this.fetch<Team9Channel>(`/im/channels/${channelId}`);
  }

  async getUserChannels(): Promise<Team9Channel[]> {
    return this.fetch<Team9Channel[]>("/im/channels");
  }

  // ==================== Messages ====================

  async getChannelMessages(
    channelId: string,
    options?: { limit?: number; before?: string }
  ): Promise<Team9Message[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", options.limit.toString());
    if (options?.before) params.set("before", options.before);

    const query = params.toString() ? `?${params.toString()}` : "";
    return this.fetch<Team9Message[]>(
      `/im/channels/${channelId}/messages${query}`
    );
  }

  async sendMessage(
    channelId: string,
    dto: CreateMessageDto
  ): Promise<Team9Message> {
    return this.fetch<Team9Message>(`/im/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify(dto),
    });
  }

  async getMessage(messageId: string): Promise<Team9Message> {
    return this.fetch<Team9Message>(`/im/messages/${messageId}`);
  }

  async updateMessage(
    messageId: string,
    content: string
  ): Promise<Team9Message> {
    return this.fetch<Team9Message>(`/im/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    });
  }

  async deleteMessage(messageId: string): Promise<{ success: boolean }> {
    return this.fetch<{ success: boolean }>(`/im/messages/${messageId}`, {
      method: "DELETE",
    });
  }

  // ==================== Reactions ====================

  async addReaction(
    messageId: string,
    emoji: string
  ): Promise<{ success: boolean }> {
    return this.fetch<{ success: boolean }>(
      `/im/messages/${messageId}/reactions`,
      {
        method: "POST",
        body: JSON.stringify({ emoji }),
      }
    );
  }

  async removeReaction(
    messageId: string,
    emoji: string
  ): Promise<{ success: boolean }> {
    return this.fetch<{ success: boolean }>(
      `/im/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
      {
        method: "DELETE",
      }
    );
  }

  // ==================== Read Status ====================

  async markAsRead(
    channelId: string,
    messageId: string
  ): Promise<{ success: boolean }> {
    return this.fetch<{ success: boolean }>(`/im/channels/${channelId}/read`, {
      method: "POST",
      body: JSON.stringify({ messageId }),
    });
  }

  // ==================== Users ====================

  async getUser(userId: string): Promise<Team9User> {
    return this.fetch<Team9User>(`/users/${userId}`);
  }

  // ==================== Direct Messages ====================

  /**
   * Get or create a direct message channel with a user
   */
  async getOrCreateDmChannel(targetUserId: string): Promise<Team9Channel> {
    return this.fetch<Team9Channel>(`/im/channels/dm/${targetUserId}`, {
      method: "POST",
    });
  }
}

// Factory function
export function createTeam9ApiClient(account: ResolvedTeam9Account): Team9ApiClient {
  return new Team9ApiClient(account.baseUrl, account.token);
}
