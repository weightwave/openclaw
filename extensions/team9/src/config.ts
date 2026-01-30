/**
 * Team9 Configuration Resolver
 *
 * Handles configuration parsing and account resolution
 */

import type {
  Team9Config,
  Team9AccountConfig,
  ResolvedTeam9Account,
} from "./types.js";

const DEFAULT_ACCOUNT_ID = "default";

type OpenClawConfig = {
  channels?: {
    team9?: Team9Config;
  };
};

/**
 * Get Team9 config from OpenClaw config
 */
export function getTeam9Config(cfg: OpenClawConfig): Team9Config | undefined {
  return cfg.channels?.team9;
}

/**
 * List all configured Team9 account IDs
 */
export function listTeam9AccountIds(cfg: OpenClawConfig): string[] {
  const team9Config = getTeam9Config(cfg);
  if (!team9Config) return [];

  const accountIds: string[] = [];

  // Add named accounts
  if (team9Config.accounts) {
    accountIds.push(...Object.keys(team9Config.accounts));
  }

  // Add default account if configured at root level
  if (
    (team9Config.baseUrl || team9Config.credentials?.token) &&
    !accountIds.includes(DEFAULT_ACCOUNT_ID)
  ) {
    accountIds.unshift(DEFAULT_ACCOUNT_ID);
  }

  return accountIds;
}

/**
 * Get the default account ID
 */
export function getDefaultTeam9AccountId(cfg: OpenClawConfig): string {
  const accountIds = listTeam9AccountIds(cfg);
  return accountIds[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve a Team9 account configuration
 */
export function resolveTeam9Account(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedTeam9Account {
  const { cfg, accountId } = params;
  const team9Config = getTeam9Config(cfg);

  const resolvedAccountId = accountId ?? getDefaultTeam9AccountId(cfg);
  const isDefault = resolvedAccountId === DEFAULT_ACCOUNT_ID;

  // Get account-specific config
  const accountConfig = team9Config?.accounts?.[resolvedAccountId];

  // Merge default and account-specific config
  const baseUrl =
    accountConfig?.baseUrl ??
    team9Config?.baseUrl ??
    process.env.TEAM9_BASE_URL ??
    "http://localhost:3000";

  const wsUrl =
    accountConfig?.wsUrl ??
    team9Config?.wsUrl ??
    process.env.TEAM9_WS_URL ??
    `${baseUrl.replace(/^http/, "ws")}/im`;

  // Token from credentials (env var TEAM9_TOKEN takes priority)
  const token =
    process.env.TEAM9_TOKEN ??
    accountConfig?.credentials?.token ??
    (isDefault ? team9Config?.credentials?.token : undefined);

  const dmPolicy =
    accountConfig?.dm?.policy ??
    team9Config?.dm?.policy ??
    "pairing";

  const allowFrom =
    accountConfig?.dm?.allowFrom ??
    team9Config?.dm?.allowFrom ??
    [];

  const channelAllowlist = accountConfig?.channels?.allowlist ?? [];

  const enabled =
    accountConfig?.enabled ?? team9Config?.enabled ?? true;

  return {
    accountId: resolvedAccountId,
    name: accountConfig?.name,
    enabled,
    baseUrl,
    wsUrl,
    token,
    dmPolicy,
    allowFrom,
    channelAllowlist,
  };
}

/**
 * Check if an account is configured (has required fields)
 */
export function isTeam9AccountConfigured(
  account: ResolvedTeam9Account
): boolean {
  // Token must be present (from env var or config)
  return Boolean(account.token);
}

/**
 * Describe an account for status display
 */
export function describeTeam9Account(account: ResolvedTeam9Account): {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  baseUrl: string;
  hasToken: boolean;
} {
  return {
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: isTeam9AccountConfigured(account),
    baseUrl: account.baseUrl,
    hasToken: Boolean(account.token),
  };
}

/**
 * Apply account config to OpenClaw config
 */
export function applyTeam9AccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: {
    baseUrl?: string;
    wsUrl?: string;
    token?: string;
  };
}): OpenClawConfig {
  const { cfg, accountId, input } = params;
  const isDefault = accountId === DEFAULT_ACCOUNT_ID;

  if (isDefault) {
    // Apply to root level
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        team9: {
          ...cfg.channels?.team9,
          enabled: true,
          baseUrl: input.baseUrl ?? cfg.channels?.team9?.baseUrl,
          wsUrl: input.wsUrl ?? cfg.channels?.team9?.wsUrl,
          credentials: input.token
            ? { token: input.token }
            : cfg.channels?.team9?.credentials,
        },
      },
    };
  }

  // Apply to named account
  const existingAccount = cfg.channels?.team9?.accounts?.[accountId] ?? {};
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      team9: {
        ...cfg.channels?.team9,
        enabled: true,
        accounts: {
          ...cfg.channels?.team9?.accounts,
          [accountId]: {
            ...existingAccount,
            accountId,
            baseUrl: input.baseUrl ?? existingAccount.baseUrl,
            wsUrl: input.wsUrl ?? existingAccount.wsUrl,
            credentials: input.token
              ? { token: input.token }
              : existingAccount.credentials,
          },
        },
      },
    },
  };
}
