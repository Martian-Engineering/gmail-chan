import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
  resolveSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import {
  GmailChannelConfigSchema,
  type GmailAccountConfig,
  type GmailChannelConfig,
  type GmailChannelConfigInput,
} from "./config.js";

export type GmailCoreConfig = Omit<OpenClawConfig, "channels"> & {
  channels?: OpenClawConfig["channels"] & { gmail?: GmailChannelConfigInput };
};

export type ResolvedGmailAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  email: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  allowFrom: string[];
  allowTo: string[];
  pollIntervalSeconds: number;
};

type OAuthInspection = "configured" | "missing";

export type GmailAccountInspection = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  email: string;
  oauth: {
    clientId: OAuthInspection;
    clientSecret: OAuthInspection;
    refreshToken: OAuthInspection;
  };
};

function readChannelConfig(cfg: GmailCoreConfig): GmailChannelConfig {
  return GmailChannelConfigSchema.parse(cfg.channels?.gmail ?? {});
}

function requireAccount(
  cfg: GmailCoreConfig,
  accountId?: string | null,
): {
  accountId: string;
  channel: GmailChannelConfig;
  account: GmailAccountConfig;
} {
  const channel = readChannelConfig(cfg);
  const resolvedId = accountId?.trim() || resolveDefaultGmailAccountId(cfg);
  const account = channel.accounts[resolvedId];
  if (!account) {
    throw new Error(`Gmail account "${resolvedId}" is not configured`);
  }
  return { accountId: resolvedId, channel, account };
}

function resolveOAuthSecret(params: {
  cfg: GmailCoreConfig;
  value: unknown;
  path: string;
  env: NodeJS.ProcessEnv;
}): string {
  const resolution = resolveSecretInputString({
    value: params.value,
    ...(params.cfg.secrets?.defaults
      ? { defaults: params.cfg.secrets.defaults }
      : {}),
    path: params.path,
    mode: "inspect",
  });
  if (resolution.status === "available") {
    return normalizeSecretInputString(resolution.value) ?? "";
  }
  if (
    resolution.status === "configured_unavailable" &&
    resolution.ref.source === "env"
  ) {
    return params.env[resolution.ref.id]?.trim() ?? "";
  }
  return "";
}

function inspectOAuthSecret(
  cfg: GmailCoreConfig,
  value: unknown,
): OAuthInspection {
  return hasConfiguredSecretInput(value, cfg.secrets?.defaults)
    ? "configured"
    : "missing";
}

/** Lists configured Gmail account IDs in stable order. */
export function listGmailAccountIds(cfg: GmailCoreConfig): string[] {
  return Object.keys(readChannelConfig(cfg).accounts).sort();
}

/** Resolves the explicit default or the first configured Gmail account. */
export function resolveDefaultGmailAccountId(cfg: GmailCoreConfig): string {
  const channel = readChannelConfig(cfg);
  if (channel.defaultAccount) {
    return channel.defaultAccount;
  }
  const first = Object.keys(channel.accounts).sort()[0];
  if (!first) {
    throw new Error("No Gmail accounts are configured");
  }
  return first;
}

/** Resolves one Gmail account and materializes env-backed OAuth inputs. */
export function resolveGmailAccount(params: {
  cfg: GmailCoreConfig;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): ResolvedGmailAccount {
  const { accountId, channel, account } = requireAccount(
    params.cfg,
    params.accountId,
  );
  const env = params.env ?? process.env;
  const path = `channels.gmail.accounts.${accountId}.oauth`;
  const clientId = resolveOAuthSecret({
    cfg: params.cfg,
    value: account.oauth.clientId,
    path: `${path}.clientId`,
    env,
  });
  const clientSecret = resolveOAuthSecret({
    cfg: params.cfg,
    value: account.oauth.clientSecret,
    path: `${path}.clientSecret`,
    env,
  });
  const refreshToken = resolveOAuthSecret({
    cfg: params.cfg,
    value: account.oauth.refreshToken,
    path: `${path}.refreshToken`,
    env,
  });
  const enabled = channel.enabled && account.enabled;
  return {
    accountId,
    ...(account.name ? { name: account.name } : {}),
    enabled,
    configured: enabled && Boolean(clientId && clientSecret && refreshToken),
    email: account.email,
    clientId,
    clientSecret,
    refreshToken,
    allowFrom: account.allowFrom,
    allowTo: account.allowTo,
    pollIntervalSeconds: account.pollIntervalSeconds,
  };
}

/** Describes account readiness without returning OAuth secret values or references. */
export function inspectGmailAccount(
  cfg: GmailCoreConfig,
  requestedAccountId?: string | null,
): GmailAccountInspection {
  const { accountId, channel, account } = requireAccount(
    cfg,
    requestedAccountId,
  );
  const oauth = {
    clientId: inspectOAuthSecret(cfg, account.oauth.clientId),
    clientSecret: inspectOAuthSecret(cfg, account.oauth.clientSecret),
    refreshToken: inspectOAuthSecret(cfg, account.oauth.refreshToken),
  };
  const enabled = channel.enabled && account.enabled;
  return {
    accountId,
    enabled,
    configured:
      enabled &&
      Object.values(oauth).every((status) => status === "configured"),
    email: account.email,
    oauth,
  };
}
