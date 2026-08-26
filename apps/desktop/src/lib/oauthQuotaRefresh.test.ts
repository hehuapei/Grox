import { describe, expect, it } from "vitest";
import { OAUTH_QUOTA_REFRESH_MS, shouldRefreshOauthQuota } from "./oauthQuotaRefresh";

const ready = {
  visibilityState: "visible" as const,
  authInProgress: false,
  accountLoading: false,
  providerKind: "oauth",
  authenticated: true,
};

describe("shouldRefreshOauthQuota", () => {
  it("polls visible authenticated oauth accounts once a minute", () => {
    expect(OAUTH_QUOTA_REFRESH_MS).toBe(60_000);
    expect(shouldRefreshOauthQuota(ready)).toBe(true);
  });

  it("does not poll while hidden, authenticating, loading, or on non-oauth accounts", () => {
    expect(shouldRefreshOauthQuota({ ...ready, visibilityState: "hidden" })).toBe(false);
    expect(shouldRefreshOauthQuota({ ...ready, authInProgress: true })).toBe(false);
    expect(shouldRefreshOauthQuota({ ...ready, accountLoading: true })).toBe(false);
    expect(shouldRefreshOauthQuota({ ...ready, providerKind: "official" })).toBe(false);
    expect(shouldRefreshOauthQuota({ ...ready, authenticated: false })).toBe(false);
  });
});
