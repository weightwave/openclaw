/**
 * Team9 Configuration Resolver
 *
 * Handles configuration parsing and account resolution
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type {
  Team9Config,
  Team9AccountConfig,
  ResolvedTeam9Account,
  Team9TokenSource,
} from "./types.js";

const DEFAULT_ACCOUNT_ID = "default";

/** Bot access token prefix used by Team9 server */
const TEAM9_BOT_TOKEN_PREFIX = "t9bot_";

/**
 * Normalize and validate a Team9 bot access token.
 * Expected format: "t9bot_" prefix + 96 hex characters.
 * Returns the trimmed token if non-empty, undefined otherwise.
 * Logs a warning if the format does not match the expected bot token pattern.
 */
export function normalizeTeam9Token(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith(TEAM9_BOT_TOKEN_PREFIX)) {
    console.warn(
      `[Team9] Token does not start with '${TEAM9_BOT_TOKEN_PREFIX}'. ` +
      `Expected a bot access token (t9bot_...), got prefix '${trimmed.slice(0, 6)}...'. ` +
      `If this is intentional (e.g. test/mock token), you can ignore this warning.`,
    );
  }
  return trimmed;
}

export type Team9TokenResolution = {
  token: string;
  source: Team9TokenSource;
};

/**
 * Resolve the Team9 bot access token from config or env.
 * Priority: account-specific config → root config → env var (default account only).
 */
export function resolveTeam9Token(
  cfg: OpenClawConfig | undefined,
  opts: { accountId?: string | null } = {},
): Team9TokenResolution {
  const team9Config = cfg ? getTeam9Config(cfg) : undefined;
  const resolvedAccountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const isDefault = resolvedAccountId === DEFAULT_ACCOUNT_ID;

  // 1. Account-specific config token
  const accountToken = normalizeTeam9Token(
    team9Config?.accounts?.[resolvedAccountId]?.credentials?.token,
  );
  if (accountToken) return { token: accountToken, source: "config" };

  // 2. Root-level config token (only for default account)
  if (isDefault) {
    const configToken = normalizeTeam9Token(team9Config?.credentials?.token);
    if (configToken) return { token: configToken, source: "config" };
  }

  // 3. Environment variable (only for default account)
  if (isDefault) {
    const envToken = normalizeTeam9Token(process.env.TEAM9_TOKEN);
    if (envToken) return { token: envToken, source: "env" };
  }

  return { token: "", source: "none" };
}


/**
 * Get Team9 config from OpenClaw config
 */
export function getTeam9Config(cfg: OpenClawConfig): Team9Config | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.team9 as Team9Config | undefined;
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

  // Resolve token using the standard resolution pattern
  const tokenResolution = resolveTeam9Token(cfg, { accountId: resolvedAccountId });

  // Resolve DM policy with legacy migration ("allow" → "open", "deny" → "disabled")
  let rawPolicy: string | undefined =
    accountConfig?.dm?.policy ??
    team9Config?.dm?.policy;
  if (rawPolicy === "allow") rawPolicy = "open";
  if (rawPolicy === "deny") rawPolicy = "disabled";
  const dmPolicy = (rawPolicy as ResolvedTeam9Account["dmPolicy"]) ?? "pairing";

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
    token: tokenResolution.token || undefined,
    tokenSource: tokenResolution.source,
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
  tokenSource: Team9TokenSource;
} {
  return {
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: isTeam9AccountConfigured(account),
    baseUrl: account.baseUrl,
    hasToken: Boolean(account.token),
    tokenSource: account.tokenSource,
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
  const team9Config = getTeam9Config(cfg);

  if (isDefault) {
    // Apply to root level
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        team9: {
          ...team9Config,
          enabled: true,
          baseUrl: input.baseUrl ?? team9Config?.baseUrl,
          wsUrl: input.wsUrl ?? team9Config?.wsUrl,
          credentials: input.token
            ? { token: input.token }
            : team9Config?.credentials,
        },
      },
    };
  }

  // Apply to named account
  const existingAccount: Partial<Team9AccountConfig> = team9Config?.accounts?.[accountId] ?? {};
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      team9: {
        ...team9Config,
        enabled: true,
        accounts: {
          ...team9Config?.accounts,
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
