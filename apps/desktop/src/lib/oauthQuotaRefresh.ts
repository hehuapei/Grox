export const OAUTH_QUOTA_REFRESH_MS = 60_000;

export function shouldRefreshOauthQuota(input: {
  visibilityState: DocumentVisibilityState;
  authInProgress: boolean;
  accountLoading: boolean;
  providerKind: string;
  authenticated: boolean;
}): boolean {
  return input.visibilityState === "visible"
    && !input.authInProgress
    && !input.accountLoading
    && input.providerKind === "oauth"
    && input.authenticated;
}
