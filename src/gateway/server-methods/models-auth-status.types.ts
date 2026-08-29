import type {
  AuthProfileHealthStatus,
  AuthProviderHealthStatus,
} from "../../agents/auth-health.js";
import type { AuthCredentialReasonCode } from "../../agents/auth-profiles/credential-state.js";
import type {
  ProviderUsageBilling,
  ProviderUsageCostHistory,
  UsageProviderId,
  UsageWindow,
} from "../../infra/provider-usage.types.js";

/** Time-bounded credential expiry projected to gateway clients. */
export type ModelAuthExpiry = {
  at: number;
  remainingMs: number;
  label: string;
};

export type ModelAuthUsage = {
  providerId: UsageProviderId;
  windows: UsageWindow[];
  summary?: string;
  plan?: string;
  billing?: ProviderUsageBilling[];
  costHistory?: ProviderUsageCostHistory;
  accountEmail?: string;
  error?: string;
};

export type ModelAuthStatusProfile = {
  profileId: string;
  type: "oauth" | "token" | "api_key";
  status: AuthProfileHealthStatus;
  reasonCode?: AuthCredentialReasonCode;
  expiry?: ModelAuthExpiry;
  /** True only for saved OAuth/token profiles this gateway can remove. */
  logoutSupported?: boolean;
  /** Credential refresh is owned by an external CLI rather than OpenClaw. */
  externallyManaged?: boolean;
  displayName?: string;
  email?: string;
  lastUsedAt?: number;
  /** Account-scoped provider quota and billing facts for this exact credential. */
  usage?: ModelAuthUsage;
  /** This account's usage cache is refreshing in the background. */
  usageRefreshPending?: true;
};

export type ModelAuthStatusProvider = {
  provider: string;
  /** Canonical credential owner used for profile ordering mutations. */
  authProvider?: string;
  displayName: string;
  status: AuthProviderHealthStatus;
  expiry?: ModelAuthExpiry;
  profiles: ModelAuthStatusProfile[];
  /** Explicit stored/config priority. Omitted when selection is automatic. */
  profileOrder?: string[];
  /** True when the priority is a stored override that can be reset. */
  profileOrderStored?: boolean;
  apiKey?: {
    source: "config" | "env";
    envVar?: string;
  };
  usage?: ModelAuthUsage;
};

export type ModelProviderCapability = {
  provider: string;
  apiKeySupported: boolean;
  quickApiKeySetup: boolean;
};

export type ModelAuthStatusResult = {
  /** Snapshot build time, ms since epoch. 0 = never loaded (UI fallback sentinel). */
  ts: number;
  providers: ModelAuthStatusProvider[];
  /** Process-stable provider setup capabilities from the active plugin generation. */
  providerCapabilities?: ModelProviderCapability[];
  /** Account usage is still filling its credential-bound cache. */
  usageRefreshPending?: boolean;
};

export type ModelAuthLogoutResult = {
  provider: string;
  removedProfiles: string[];
  abortedRunIds: string[];
};

export type ModelAuthOrderSetResult = {
  provider: string;
  profileIds: string[] | null;
};
