/**
 * Team9 Media Utilities
 *
 * Handles inbound media download and outbound media upload for Team9 messages.
 * Follows the standard OpenClaw media pattern (Discord/Slack).
 */

import type { Team9MessageAttachment, Team9OutboundAttachment } from "./types.js";
import type { Team9ApiClient } from "./api-client.js";
import { getTeam9Runtime } from "./runtime.js";

// ==================== Types ====================

export type Team9MediaInfo = {
  path: string;
  contentType?: string;
  placeholder: string;
};

export type Team9MediaPayload = {
  MediaPath?: string;
  MediaUrl?: string;
  MediaType?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
};

// ==================== Inbound: Download & Save ====================

const INBOUND_MAX_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * Infer a placeholder tag from the MIME type.
 */
function inferPlaceholder(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "<media:image>";
  if (mimeType.startsWith("video/")) return "<media:video>";
  if (mimeType.startsWith("audio/")) return "<media:audio>";
  return "<media:document>";
}

/**
 * Generate a fallback body text for attachment-only messages.
 * Pattern: "<media:image> (2 images)" or "<media:document> (3 files)"
 */
export function buildAttachmentPlaceholder(
  attachments: Team9MessageAttachment[],
): string {
  if (attachments.length === 0) return "";
  const allImages = attachments.every((a) => a.mimeType?.startsWith("image/"));
  const label = allImages ? "image" : "file";
  const count = attachments.length;
  const suffix = count === 1 ? label : `${label}s`;
  const tag = allImages ? "<media:image>" : "<media:document>";
  return `${tag} (${count} ${suffix})`;
}

/**
 * Resolve the download URL for an attachment.
 * Prefers fileUrl (direct S3 URL), falls back to presigned download URL.
 */
async function resolveAttachmentUrl(
  attachment: Team9MessageAttachment,
  api: Team9ApiClient,
): Promise<string> {
  // Prefer presigned URL via fileKey (works with private S3/MinIO buckets)
  if (attachment.fileKey) {
    const result = await api.getFileDownloadUrl(attachment.fileKey);
    return result.url;
  }
  if (attachment.fileUrl) {
    return attachment.fileUrl;
  }
  // Legacy fallback
  if (attachment.url) {
    return attachment.url;
  }
  throw new Error(`Attachment ${attachment.id} has no downloadable URL`);
}

/**
 * Download and save all attachments from an incoming Team9 message.
 */
export async function downloadTeam9Attachments(
  attachments: Team9MessageAttachment[],
  api: Team9ApiClient,
  maxBytes: number = INBOUND_MAX_BYTES,
): Promise<Team9MediaInfo[]> {
  if (!attachments || attachments.length === 0) return [];

  const runtime = getTeam9Runtime();
  const results: Team9MediaInfo[] = [];

  for (const attachment of attachments) {
    try {
      const url = await resolveAttachmentUrl(attachment, api);

      const fetched = await runtime.channel.media.fetchRemoteMedia({
        url,
        filePathHint: attachment.fileName ?? url,
      });

      const saved = await runtime.channel.media.saveMediaBuffer(
        fetched.buffer,
        fetched.contentType ?? attachment.mimeType,
        "inbound",
        maxBytes,
        attachment.fileName,
      );

      results.push({
        path: saved.path,
        contentType: saved.contentType,
        placeholder: inferPlaceholder(saved.contentType ?? attachment.mimeType ?? ""),
      });
    } catch (err) {
      console.error(
        `[Team9] Failed to download attachment ${attachment.id} (${attachment.fileName}): ${String(err)}`,
      );
    }
  }

  return results;
}

/**
 * Build the media payload fields for finalizeInboundContext.
 * Same pattern as Discord's buildDiscordMediaPayload.
 */
export function buildTeam9MediaPayload(
  mediaList: Team9MediaInfo[],
): Team9MediaPayload {
  if (mediaList.length === 0) return {};

  const first = mediaList[0];
  const mediaPaths = mediaList.map((m) => m.path);
  const mediaTypes = mediaList
    .map((m) => m.contentType)
    .filter(Boolean) as string[];

  return {
    MediaPath: first?.path,
    MediaType: first?.contentType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}

// ==================== Outbound: Upload to Team9 ====================

/**
 * Upload a media file to Team9 via the presigned S3 flow.
 *
 * Steps:
 * 1. POST /v1/files/presign -> get presigned URL + fields
 * 2. POST FormData to S3 presigned URL
 * 3. POST /v1/files/confirm -> confirm upload
 */
export async function uploadMediaToTeam9(
  api: Team9ApiClient,
  params: {
    buffer: Buffer;
    fileName: string;
    contentType: string;
    channelId?: string;
  },
): Promise<Team9OutboundAttachment> {
  const { buffer, fileName, contentType, channelId } = params;

  const presigned = await api.createPresignedUpload({
    filename: fileName,
    contentType,
    fileSize: buffer.byteLength,
    channelId,
  });

  await api.uploadToS3(presigned.url, buffer, presigned.fields, contentType);

  const confirmed = await api.confirmUpload({
    key: presigned.key,
    fileName,
    channelId,
  });

  return {
    fileKey: presigned.key,
    fileName: confirmed.fileName,
    mimeType: confirmed.mimeType,
    fileSize: confirmed.fileSize,
  };
}
