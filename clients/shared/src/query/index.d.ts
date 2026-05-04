import type { QueryClient, UseQueryOptions, UseQueryResult } from "@tanstack/react-query";
import type { BaseUrlResolver, DebugStatsResponse, IntegrationsStatus } from "../types/api";

export function createDefaultQueryClient(): QueryClient;
export const sharedQueryKeys: {
  integrationsStatus: (baseUrl: string) => readonly ["shared", "integrations-status", string];
  debugStats: (baseUrl: string) => readonly ["shared", "debug-stats", string];
};
export function useIntegrationsStatusQuery(
  resolveBaseUrl: BaseUrlResolver,
  options?: Omit<UseQueryOptions<IntegrationsStatus, Error, IntegrationsStatus, readonly unknown[]>, "queryKey" | "queryFn">,
): UseQueryResult<IntegrationsStatus, Error>;
export function useDebugStatsQuery(
  resolveBaseUrl: BaseUrlResolver,
  options?: Omit<UseQueryOptions<DebugStatsResponse, Error, DebugStatsResponse, readonly unknown[]>, "queryKey" | "queryFn">,
): UseQueryResult<DebugStatsResponse, Error>;
