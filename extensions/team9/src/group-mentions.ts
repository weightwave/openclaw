/**
 * Team9 Group Mention Resolution
 *
 * Resolves whether a Team9 group channel requires the bot to be mentioned
 * before it responds. Follows the same pattern as Matrix and Mattermost
 * extension group-mentions resolvers.
 */

import type { ChannelGroupContext } from "openclaw/plugin-sdk";
import type { Team9GroupConfig } from "./types.js";

type Team9CoreConfig = {
  channels?: {
    team9?: {
      groups?: Record<string, Team9GroupConfig>;
      accounts?: Record<
        string,
        {
          groups?: Record<string, Team9GroupConfig>;
        }
      >;
    };
  };
};

/**
 * Resolve whether a Team9 group channel requires mention to trigger the bot.
 *
 * Config lookup order:
 * 1. Account-specific: channels.team9.accounts[accountId].groups[channelId].requireMention
 * 2. Root-level: channels.team9.groups[channelId].requireMention
 * 3. Wildcard fallback: groups["*"].requireMention
 * 4. Default: true (require mention by default)
 */
export function resolveTeam9GroupRequireMention(
  params: ChannelGroupContext,
): boolean {
  const cfg = params.cfg as Team9CoreConfig;
  const team9Config = cfg.channels?.team9;
  if (!team9Config) return true;

  const accountId = params.accountId?.trim();
  const channelId = params.groupId?.trim() ?? "";

  // Try account-specific groups config first
  const accountGroups = accountId
    ? team9Config.accounts?.[accountId]?.groups
    : undefined;

  // Then fall back to root-level groups config
  const groups = accountGroups ?? team9Config.groups;
  if (!groups) return true;

  // Match by channel ID
  if (channelId && groups[channelId]) {
    const entry = groups[channelId];
    if (typeof entry.requireMention === "boolean") {
      return entry.requireMention;
    }
  }

  // Wildcard fallback
  const wildcard = groups["*"];
  if (wildcard && typeof wildcard.requireMention === "boolean") {
    return wildcard.requireMention;
  }

  return true; // Default: require mention
}
