/**
 * Team9 Inbound Message Preflight
 *
 * Handles the "prepare" phase of inbound message processing:
 * - HTML parsing and mention extraction
 * - Attachment download
 * - Group mention gating
 * - Agent routing
 * - Inbound context construction
 *
 * Returns a PreparedTeam9Message ready for dispatch, or null to skip.
 */

import { resolveMentionGatingWithBypass } from "openclaw/plugin-sdk";
import type { Team9IncomingMessage } from "../types.js";
import type { Team9MonitorContext } from "./context.js";
import { getTeam9Runtime } from "../runtime.js";
import { resolveTeam9GroupRequireMention } from "../group-mentions.js";
import {
  downloadTeam9Attachments,
  buildTeam9MediaPayload,
  buildAttachmentPlaceholder,
} from "../media.js";

// Re-use the finalized context type from the runtime
export type PreparedTeam9Message = {
  ctx: Team9MonitorContext;
  message: Team9IncomingMessage;
  // Structural subset of FinalizedMsgContext (not importable from plugin-sdk)
  ctxPayload: { CommandAuthorized: boolean } & Record<string, unknown>;
  channelId: string;
  route: { agentId?: string | null; sessionKey: string; matchedBy?: string };
};

/**
 * Strip HTML tags and decode HTML entities for plain text processing.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Extract mentioned user IDs from Team9 <mention> HTML tags.
 */
function extractMentionedUserIds(content: string): Set<string> {
  const ids = new Set<string>();
  const regex = /<mention\s[^>]*data-user-id="([^"]+)"[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    ids.add(match[1]);
  }
  return ids;
}

/**
 * Preflight: validate, parse, and build context for an inbound Team9 message.
 * Returns null if the message should be skipped.
 */
export async function prepareTeam9Message(params: {
  ctx: Team9MonitorContext;
  message: Team9IncomingMessage;
}): Promise<PreparedTeam9Message | null> {
  const { ctx, message } = params;
  const runtime = getTeam9Runtime();

  // Extract mentioned user IDs from HTML before stripping
  const mentionedUserIds = extractMentionedUserIds(message.content);

  // Strip HTML for plain text processing
  const plainContent = stripHtml(message.content);

  const hasAttachments = message.attachments && message.attachments.length > 0;

  // Skip if no text content and no attachments
  if (!plainContent && !hasAttachments) {
    return null;
  }

  // Download and save attachments locally
  const mediaList = hasAttachments
    ? await downloadTeam9Attachments(message.attachments!, ctx.api)
    : [];

  // For attachment-only messages, generate placeholder text
  const effectiveBody =
    plainContent || buildAttachmentPlaceholder(message.attachments ?? []);

  if (!effectiveBody) {
    return null;
  }

  // Route to agent via core framework
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: "team9",
    accountId: ctx.account.accountId,
    peer: {
      kind: message.isGroup ? "group" : "dm",
      id: message.channelId,
    },
  });
  const agentId = route.agentId;

  // ===== Mention-based filtering for group messages =====
  let effectiveWasMentioned: boolean | undefined;

  if (message.isGroup) {
    const requireMention = resolveTeam9GroupRequireMention({
      cfg: ctx.cfg,
      groupId: message.channelId,
      groupChannel: message.channelId,
      accountId: ctx.account.accountId,
    });

    const mentionRegexes = runtime.channel.mentions.buildMentionRegexes(
      ctx.cfg,
      agentId,
    );

    // Detect explicit @-mention of the bot
    const explicitlyMentioned = Boolean(
      ctx.botUserId && mentionedUserIds.has(ctx.botUserId),
    );
    const hasAnyMention =
      mentionedUserIds.size > 0 || /@\w+/.test(effectiveBody);

    const wasMentioned = runtime.channel.mentions.matchesMentionWithExplicit({
      text: effectiveBody,
      mentionRegexes,
      explicit: {
        hasAnyMention,
        isExplicitlyMentioned: explicitlyMentioned,
        canResolveExplicit: Boolean(ctx.botUserId || ctx.botUsername),
      },
    });

    console.log(
      `[Team9] Mention check: ` +
        `requireMention=${requireMention}, explicitlyMentioned=${explicitlyMentioned}, ` +
        `hasAnyMention=${hasAnyMention}, wasMentioned=${wasMentioned}`,
    );

    const canDetectMention =
      Boolean(ctx.botUserId || ctx.botUsername) || mentionRegexes.length > 0;
    const mentionGate = resolveMentionGatingWithBypass({
      isGroup: true,
      requireMention,
      canDetectMention,
      wasMentioned,
      implicitMention: false,
      hasAnyMention,
      allowTextCommands: runtime.channel.commands.shouldHandleTextCommands({
        cfg: ctx.cfg,
        surface: "team9",
      }),
      hasControlCommand: runtime.channel.text.hasControlCommand(
        effectiveBody,
        ctx.cfg,
      ),
      commandAuthorized: true,
    });

    if (mentionGate.shouldSkip) {
      console.log(
        `[Team9] Skipping group message in channel ${message.channelId} (mention required but not mentioned)`,
      );
      return null;
    }

    effectiveWasMentioned = mentionGate.effectiveWasMentioned;
  }

  const sessionKey = route.sessionKey;

  console.log(
    `[Team9] Routed: agentId=${agentId}, matchedBy=${route.matchedBy}, sessionKey=${sessionKey}`,
  );

  // Build media payload from downloaded attachments
  const mediaPayload = buildTeam9MediaPayload(mediaList);

  // Build the message context
  const fromLabel = message.isGroup
    ? `Team9 Channel ${message.channelId}`
    : `Team9 DM from ${message.senderName || message.senderId}`;

  const to = `team9:${message.channelId}`;

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: effectiveBody,
    RawBody: message.content,
    CommandBody: plainContent || effectiveBody,
    From: to,
    To: to,
    SessionKey: sessionKey,
    AccountId: ctx.account.accountId,
    ChatType: message.isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: message.senderName || "Unknown",
    SenderId: message.senderId,
    Provider: "team9" as const,
    Surface: "team9" as const,
    MessageSid: message.messageId,
    Timestamp: message.timestamp.getTime(),
    CommandAuthorized: true,
    WasMentioned: message.isGroup ? effectiveWasMentioned : undefined,
    OriginatingChannel: "team9" as const,
    OriginatingTo: to,
    ...mediaPayload,
  });

  return {
    ctx,
    message,
    ctxPayload,
    channelId: message.channelId,
    route,
  };
}
