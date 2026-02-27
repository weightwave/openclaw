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
 * Resolve the parentId for a bot reply.
 *
 * - Root message where bot was @mentioned: reply as thread (parentId = message ID)
 * - Thread message: stay in the same thread (parentId = message's parentId)
 * - All other cases: use message's original parentId
 */
function resolveReplyParentId(
  prepared: PreparedTeam9Message,
): string | undefined {
  const { message, wasBotMentioned } = prepared;

  if (!message.parentId && wasBotMentioned) {
    // Bot was @mentioned in a root message — create a new thread
    return message.messageId;
  }

  // Thread message or non-mentioned root — keep original parentId
  return message.parentId;
}

/**
 * Dispatch a prepared message to the AI agent and deliver replies.
 */
export async function dispatchPreparedTeam9Message(
  prepared: PreparedTeam9Message,
): Promise<void> {
  const { ctx, message, ctxPayload, route, wasBotMentioned } = prepared;
  const runtime = getTeam9Runtime();
  const channelId = message.channelId;
  const replyParentId = resolveReplyParentId(prepared);

  // Track this thread for auto-reply if bot was @mentioned in a root message
  if (!message.parentId && wasBotMentioned) {
    ctx.activeBotThreads.add(message.messageId);
    console.log(
      `[Team9] Registered active bot thread: rootId=${message.messageId}`,
    );
  }

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

        if (!text && mediaUrls.length === 0) {
          console.warn(
            `[Team9] Skipping empty reply for channel=${channelId} parentId=${replyParentId} (no text, no media)`,
          );
          return;
        }

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

            console.log(
              `[Team9] Sending reply: channel=${channelId} parentId=${replyParentId} textLen=${text.length} media=${attachments.length}/${mediaUrls.length}`,
            );
            const sent = await ctx.api.sendMessage(channelId, {
              content: text,
              parentId: replyParentId,
              attachments:
                attachments.length > 0 ? attachments : undefined,
            });
            console.log(
              `[Team9] Reply delivered: messageId=${sent.id} channel=${channelId}`,
            );
          } else {
            // Text-only reply
            console.log(
              `[Team9] Sending reply: channel=${channelId} parentId=${replyParentId} textLen=${text.length}`,
            );
            const sent = await ctx.api.sendMessage(channelId, {
              content: text,
              parentId: replyParentId,
            });
            console.log(
              `[Team9] Reply delivered: messageId=${sent.id} channel=${channelId}`,
            );
          }
        } catch (err) {
          console.error(
            `[Team9] Failed to send reply: channel=${channelId} textLen=${text.length} media=${mediaUrls.length}`,
            err,
          );
        }
      },
      onError: (err, info) => {
        console.error(
          `[Team9] Reply ${info.kind} failed: channel=${channelId}`,
          err,
        );
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
    console.error(`[Team9] Failed to dispatch message: channel=${channelId}`, err);
  } finally {
    markDispatchIdle();
  }
}
