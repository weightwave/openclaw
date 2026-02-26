/**
 * Team9 Inbound Message Handler
 *
 * Creates a debouncer-based message handler following the standard
 * OpenClaw pattern (Discord/Slack). Rapid consecutive messages from
 * the same user are merged into a single agent call.
 */

import type { Team9IncomingMessage } from "../types.js";
import type { Team9MonitorContext } from "./context.js";
import { getTeam9Runtime } from "../runtime.js";
import { stripHtml, prepareTeam9Message } from "./prepare.js";
import { dispatchPreparedTeam9Message } from "./dispatch.js";

type DebouncerEntry = {
  message: Team9IncomingMessage;
};

/**
 * Create a message handler with inbound debouncing for a Team9 account.
 *
 * The returned function should be passed as onMessage to the WebSocket client.
 * It filters self-messages, debounces rapid input, merges batched messages,
 * then runs prepare → dispatch.
 */
export function createTeam9MessageHandler(
  ctx: Team9MonitorContext,
): (message: Team9IncomingMessage) => void {
  const runtime = getTeam9Runtime();

  const debounceMs = runtime.channel.debounce.resolveInboundDebounceMs({
    cfg: ctx.cfg,
    channel: "team9",
  });

  const debouncer = runtime.channel.debounce.createInboundDebouncer<DebouncerEntry>({
    debounceMs,

    buildKey: (entry) => {
      const { message } = entry;
      if (!message.senderId) return null;
      return `team9:${ctx.accountId}:${message.channelId}:${message.senderId}`;
    },

    shouldDebounce: (entry) => {
      const { message } = entry;
      // Never debounce messages with attachments
      if (message.attachments && message.attachments.length > 0) return false;
      // Never debounce control commands
      const plain = stripHtml(message.content);
      if (!plain.trim()) return false;
      return !runtime.channel.text.hasControlCommand(plain, ctx.cfg);
    },

    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) return;

      // Merge text from multiple messages
      let syntheticMessage: Team9IncomingMessage;
      if (entries.length === 1) {
        syntheticMessage = last.message;
      } else {
        const combinedContent = entries
          .map((e) => e.message.content)
          .filter(Boolean)
          .join("\n");
        syntheticMessage = { ...last.message, content: combinedContent };
      }

      console.log(
        `[Team9] Processing message from ${syntheticMessage.senderName}: ` +
          `${stripHtml(syntheticMessage.content).substring(0, 50)}... ` +
          `(${syntheticMessage.attachments?.length ?? 0} attachments` +
          `${entries.length > 1 ? `, merged ${entries.length} messages` : ""})`,
      );

      // Preflight
      const prepared = await prepareTeam9Message({
        ctx,
        message: syntheticMessage,
      });
      if (!prepared) return;

      // Record batch message IDs when multiple messages were merged
      if (entries.length > 1) {
        const ids = entries.map((e) => e.message.messageId).filter(Boolean);
        if (ids.length > 0) {
          prepared.ctxPayload.MessageSids = ids;
          prepared.ctxPayload.MessageSidFirst = ids[0];
          prepared.ctxPayload.MessageSidLast = ids.at(-1);
        }
      }

      // Dispatch
      await dispatchPreparedTeam9Message(prepared);
    },

    onError: (err) => {
      console.error(`[Team9] Debounce flush failed:`, err);
    },
  });

  // Return the handler function
  return (message: Team9IncomingMessage) => {
    // Filter self-messages
    if (ctx.botUserId && message.senderId === ctx.botUserId) {
      return;
    }
    void debouncer.enqueue({ message });
  };
}
