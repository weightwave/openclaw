/**
 * Team9 Inbound Message Dispatch
 *
 * Handles the "dispatch" phase of inbound message processing:
 * - Creates reply dispatcher with typing indicators
 * - Calls the AI agent via dispatchReplyFromConfig
 * - Delivers replies back to Team9
 */

import type { Team9OutboundAttachment } from "../types.js";
import type { PreparedTeam9Message } from "./prepare.js";
import { getTeam9Runtime } from "../runtime.js";
import { uploadMediaToTeam9 } from "../media.js";

/**
 * Dispatch a prepared message to the AI agent and deliver replies.
 */
export async function dispatchPreparedTeam9Message(
  prepared: PreparedTeam9Message,
): Promise<void> {
  const { ctx, message, ctxPayload, route } = prepared;
  const runtime = getTeam9Runtime();
  const channelId = message.channelId;

  // Create reply dispatcher with typing indicator callbacks
  const { dispatcher, replyOptions, markDispatchIdle } =
    runtime.channel.reply.createReplyDispatcherWithTyping({
      humanDelay: route.agentId
        ? runtime.channel.reply.resolveHumanDelayConfig(ctx.cfg, route.agentId)
        : undefined,
      deliver: async (payload) => {
        const mediaUrls =
          payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
        const text = payload.text ?? "";

        if (!text && mediaUrls.length === 0) return;

        try {
          if (mediaUrls.length > 0) {
            // Upload and send media attachments
            const attachments: Team9OutboundAttachment[] = [];
            for (const mediaUrl of mediaUrls) {
              try {
                const media = await runtime.media.loadWebMedia(mediaUrl);
                const attachment = await uploadMediaToTeam9(ctx.api, {
                  buffer: media.buffer,
                  fileName: media.fileName ?? "upload",
                  contentType:
                    media.contentType ?? "application/octet-stream",
                  channelId,
                });
                attachments.push(attachment);
              } catch (err) {
                console.error(
                  `[Team9] Failed to upload media in reply: ${String(err)}`,
                );
              }
            }

            await ctx.api.sendMessage(channelId, {
              content: text,
              parentId: message.parentId,
              attachments:
                attachments.length > 0 ? attachments : undefined,
            });
          } else {
            // Text-only reply
            await ctx.api.sendMessage(channelId, {
              content: text,
              parentId: message.parentId,
            });
          }
        } catch (err) {
          console.error(`[Team9] Failed to send reply:`, err);
        }
      },
      onError: (err, info) => {
        console.error(`[Team9] Reply ${info.kind} failed:`, err);
      },
      // Typing indicators: show "is typing" while the agent processes
      onReplyStart: async () => {
        ctx.ws.startTyping(channelId);
      },
      onIdle: () => {
        ctx.ws.stopTyping(channelId);
      },
    });

  // Dispatch the message to the agent
  try {
    await runtime.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg: ctx.cfg,
      dispatcher,
      replyOptions,
    });
  } catch (err) {
    console.error(`[Team9] Failed to dispatch message:`, err);
  } finally {
    markDispatchIdle();
  }
}
