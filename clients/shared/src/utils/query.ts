export const sharedQueryKeys = {
  integrationsStatus: (baseUrl: string) => ["shared", "integrations-status", baseUrl] as const,
  debugStats: (baseUrl: string) => ["shared", "debug-stats", baseUrl] as const,
};
