/**
 * Team9 Onboarding Adapter
 *
 * Enables Team9 configuration through the `openclaw onboard` wizard
 *
 * Configuration is primarily done via environment variables:
 * - TEAM9_BASE_URL: Server base URL
 * - TEAM9_TOKEN: JWT token for authentication
 */

import type {
  ChannelOnboardingAdapter,
  OpenClawConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";

import {
  listTeam9AccountIds,
  getDefaultTeam9AccountId,
  resolveTeam9Account,
  isTeam9AccountConfigured,
} from "./config.js";

const channel = "team9" as const;

/**
 * Show setup instructions for Team9
 */
async function noteTeam9Setup(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Team9 is configured via environment variables:",
      "",
      "  TEAM9_BASE_URL - Server URL (e.g., http://localhost:3000)",
      "  TEAM9_TOKEN    - JWT token for authentication",
      "",
      "These are typically set by the control plane when creating instances.",
    ].join("\n"),
    "Team9 setup"
  );
}

/**
 * Prompt for account ID selection
 */
async function promptAccountId(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  label: string;
  currentId?: string;
  defaultAccountId: string;
}): Promise<string> {
  const { cfg, prompter, label, currentId, defaultAccountId } = params;
  const accountIds = listTeam9AccountIds(cfg);

  if (accountIds.length <= 1) {
    return currentId ?? defaultAccountId;
  }

  const selected = (await prompter.select({
    message: `${label} account`,
    options: accountIds.map((accountId) => ({
      value: accountId,
      label: accountId === DEFAULT_ACCOUNT_ID ? "default (primary)" : accountId,
    })),
    initialValue: currentId ?? defaultAccountId,
  })) as string;

  return normalizeAccountId(selected) ?? defaultAccountId;
}

export const team9OnboardingAdapter: ChannelOnboardingAdapter = {
  channel,

  getStatus: async ({ cfg }) => {
    const accountIds = listTeam9AccountIds(cfg);
    const configured = accountIds.some((accountId) => {
      const account = resolveTeam9Account({ cfg, accountId });
      return isTeam9AccountConfigured(account);
    });

    // Also check env vars
    const hasEnvToken = Boolean(process.env.TEAM9_TOKEN?.trim());

    return {
      channel,
      configured: configured || hasEnvToken,
      statusLines: [
        `Team9: ${configured || hasEnvToken ? "configured" : "needs TEAM9_TOKEN env var"}`,
      ],
      selectionHint: configured || hasEnvToken ? "configured" : "needs setup",
      quickstartScore: configured || hasEnvToken ? 2 : 1,
    };
  },

  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
  }) => {
    const override = accountOverrides.team9?.trim();
    const defaultAccountId = getDefaultTeam9AccountId(cfg);
    let accountId = override
      ? (normalizeAccountId(override) ?? defaultAccountId)
      : defaultAccountId;

    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "Team9",
        currentId: accountId,
        defaultAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveTeam9Account({ cfg: next, accountId });
    const accountConfigured = isTeam9AccountConfigured(resolvedAccount);

    // Check if env vars are set
    const hasEnvToken = Boolean(process.env.TEAM9_TOKEN?.trim());

    if (hasEnvToken) {
      // Env vars are set, just enable the channel
      next = {
        ...next,
        channels: {
          ...next.channels,
          team9: {
            ...((next.channels as Record<string, unknown>)?.team9 as Record<
              string,
              unknown
            >),
            enabled: true,
          },
        },
      };
      return { cfg: next, accountId };
    }

    if (accountConfigured) {
      const keep = await prompter.confirm({
        message: "Team9 token already configured. Keep it?",
        initialValue: true,
      });
      if (keep) {
        return { cfg: next, accountId };
      }
    }

    // Show setup instructions
    await noteTeam9Setup(prompter);

    // Prompt for manual token entry (fallback)
    const token = String(
      await prompter.text({
        message: "Enter JWT token (or set TEAM9_TOKEN env var)",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      })
    ).trim();

    // Apply configuration
    const team9Config: Record<string, unknown> = {
      ...((next.channels as Record<string, unknown>)?.team9 as Record<
        string,
        unknown
      >),
      enabled: true,
    };

    if (accountId === DEFAULT_ACCOUNT_ID) {
      // Apply to root level
      team9Config.credentials = { token };
    } else {
      // Apply to named account
      const existingAccounts =
        (team9Config.accounts as Record<string, unknown>) ?? {};
      const existingAccount =
        (existingAccounts[accountId] as Record<string, unknown>) ?? {};

      team9Config.accounts = {
        ...existingAccounts,
        [accountId]: {
          ...existingAccount,
          enabled: true,
          credentials: { token },
        },
      };
    }

    next = {
      ...next,
      channels: {
        ...next.channels,
        team9: team9Config,
      },
    };

    return { cfg: next, accountId };
  },

  disable: (cfg: OpenClawConfig) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      team9: {
        ...((cfg.channels as Record<string, unknown>)?.team9 as Record<
          string,
          unknown
        >),
        enabled: false,
      },
    },
  }),

  dmPolicy: {
    label: "Team9",
    channel,
    policyKey: "channels.team9.dm.policy",
    allowFromKey: "channels.team9.dm.allowFrom",
    getCurrent: (cfg) => {
      const team9 = (cfg.channels as Record<string, unknown>)?.team9 as
        | { dm?: { policy?: "pairing" | "allow" | "deny" } }
        | undefined;
      return team9?.dm?.policy ?? "pairing";
    },
    setPolicy: (cfg, policy) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        team9: {
          ...((cfg.channels as Record<string, unknown>)?.team9 as Record<
            string,
            unknown
          >),
          dm: {
            ...(
              (cfg.channels as Record<string, unknown>)?.team9 as {
                dm?: Record<string, unknown>;
              }
            )?.dm,
            policy,
          },
        },
      },
    }),
  },
};
