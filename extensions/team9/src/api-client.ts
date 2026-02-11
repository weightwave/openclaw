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
  Team9PresignedUploadCredentials,
  Team9ConfirmUploadResult,
  Team9DownloadUrlResult,
} from "./types.js";

/**
 * Error thrown when Team9 API returns 401 or 403.
 * Callers can check `instanceof Team9AuthError` to handle auth failures specifically.
 */
export class Team9AuthError extends Error {
  public readonly statusCode: number;
  public readonly statusText: string;

  constructor(statusCode: number, statusText: string, detail: string) {
    super(`Team9 auth error (${statusCode}): ${detail}`);
    this.name = "Team9AuthError";
    this.statusCode = statusCode;
    this.statusText = statusText;
  }
}

export class Team9ApiClient {
  private baseUrl: string;
  private token: string;
  private tenantId: string | undefined;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, ""); // Remove trailing slash
    this.token = token;
  }

  setTenantId(tenantId: string): void {
    this.tenantId = tenantId;
  }

  getTenantId(): string | undefined {
    return this.tenantId;
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
    if (this.tenantId) {
      headers["X-Tenant-Id"] = this.tenantId;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 401 || response.status === 403) {
        throw new Team9AuthError(
          response.status,
          response.statusText,
          errorText ||
            "Authentication failed. Check that TEAM9_TOKEN is a valid bot access token (t9bot_...).",
        );
      }
      throw new Error(
        `Team9 API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    return response.json() as Promise<T>;
  }

  // ==================== Users ====================

  async getMe(): Promise<Team9User> {
    return this.fetch<Team9User>("/auth/me");
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

  // ==================== Files ====================

  async createPresignedUpload(params: {
    filename: string;
    contentType: string;
    fileSize: number;
    channelId?: string;
  }): Promise<Team9PresignedUploadCredentials> {
    return this.fetch<Team9PresignedUploadCredentials>("/files/presign", {
      method: "POST",
      body: JSON.stringify({
        filename: params.filename,
        contentType: params.contentType,
        fileSize: params.fileSize,
        visibility: "workspace",
        channelId: params.channelId,
      }),
    });
  }

  async uploadToS3(
    presignedUrl: string,
    buffer: Buffer,
    fields: Record<string, string>,
    contentType: string,
  ): Promise<void> {
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      formData.append(key, value);
    }
    // File must be appended last (S3 POST requirement)
    const blob = new Blob([new Uint8Array(buffer)], { type: contentType });
    formData.append("file", blob);

    const response = await fetch(presignedUrl, {
      method: "POST",
      body: formData,
    });

    if (!response.ok && response.status !== 204) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `S3 upload failed: ${response.status} ${response.statusText} ${text}`,
      );
    }
  }

  async confirmUpload(params: {
    key: string;
    fileName: string;
    channelId?: string;
  }): Promise<Team9ConfirmUploadResult> {
    return this.fetch<Team9ConfirmUploadResult>("/files/confirm", {
      method: "POST",
      body: JSON.stringify({
        key: params.key,
        fileName: params.fileName,
        visibility: "workspace",
        channelId: params.channelId,
      }),
    });
  }

  async getFileDownloadUrl(fileKey: string): Promise<Team9DownloadUrlResult> {
    return this.fetch<Team9DownloadUrlResult>(
      `/files/${encodeURIComponent(fileKey)}/download-url`,
    );
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
  if (!account.token) {
    throw new Error(
      "Cannot create Team9 API client: no bot access token available. " +
      "Set the TEAM9_TOKEN environment variable or configure credentials in config.",
    );
  }
  return new Team9ApiClient(account.baseUrl, account.token);
}
