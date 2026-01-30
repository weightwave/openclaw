/**
 * Team9 Onboarding Adapter
 *
 * Enables Team9 configuration through the `openclaw onboard` wizard
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
      "Team9 is your private instant messaging platform.",
      "",
      "Setup options:",
      "1) Use a bot account with username/password (recommended)",
      "2) Use a JWT token from an existing session",
      "",
      "Server URL: typically http://localhost:3000 for local dev",
      "Docs: https://docs.molt.bot/channels/team9",
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

    return {
      channel,
      configured,
      statusLines: [
        `Team9: ${configured ? "configured" : "needs credentials"}`,
      ],
      selectionHint: configured ? "configured" : "needs setup",
      quickstartScore: configured ? 2 : 1,
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
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv =
      allowEnv &&
      (Boolean(process.env.TEAM9_TOKEN?.trim()) ||
        (Boolean(process.env.TEAM9_BASE_URL?.trim()) &&
          Boolean(process.env.TEAM9_USERNAME?.trim()) &&
          Boolean(process.env.TEAM9_PASSWORD?.trim())));

    let baseUrl: string | null = null;
    let token: string | null = null;
    let username: string | null = null;
    let password: string | null = null;

    if (!accountConfigured) {
      await noteTeam9Setup(prompter);
    }

    if (canUseEnv) {
      const keepEnv = await prompter.confirm({
        message: "Team9 environment variables detected. Use env vars?",
        initialValue: true,
      });
      if (keepEnv) {
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
    }

    if (accountConfigured) {
      const keep = await prompter.confirm({
        message: "Team9 credentials already configured. Keep them?",
        initialValue: true,
      });
      if (keep) {
        return { cfg: next, accountId };
      }
    }

    // Prompt for configuration
    baseUrl = String(
      await prompter.text({
        message: "Enter Team9 server URL",
        initialValue: resolvedAccount.baseUrl || "http://localhost:3000",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      })
    ).trim();

    const authMethod = (await prompter.select({
      message: "Authentication method",
      options: [
        {
          value: "credentials",
          label: "Username/Password (recommended)",
        },
        { value: "token", label: "JWT Token" },
      ],
      initialValue: "credentials",
    })) as "credentials" | "token";

    if (authMethod === "token") {
      token = String(
        await prompter.text({
          message: "Enter JWT token",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        })
      ).trim();
    } else {
      username = String(
        await prompter.text({
          message: "Enter username",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        })
      ).trim();
      password = String(
        await prompter.text({
          message: "Enter password",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        })
      ).trim();
    }

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
      if (baseUrl) team9Config.baseUrl = baseUrl;
      if (token) team9Config.token = token;
      if (username && password) {
        team9Config.credentials = { username, password };
      }
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
          ...(baseUrl ? { baseUrl } : {}),
          ...(token ? { token } : {}),
          ...(username && password
            ? { credentials: { username, password } }
            : {}),
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
