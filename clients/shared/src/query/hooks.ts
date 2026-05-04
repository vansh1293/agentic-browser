import { useMemo } from "react";
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { createSharedApi } from "../utils/http";
import { sharedQueryKeys } from "./keys";
import type { BaseUrlResolver, DebugStatsResponse, IntegrationsStatus } from "../types/api";

type IntegrationsQueryOptions = Omit<UseQueryOptions<IntegrationsStatus, Error, IntegrationsStatus, readonly unknown[]>, "queryKey" | "queryFn">;
type DebugStatsQueryOptions = Omit<UseQueryOptions<DebugStatsResponse, Error, DebugStatsResponse, readonly unknown[]>, "queryKey" | "queryFn">;

export function useIntegrationsStatusQuery(resolveBaseUrl: BaseUrlResolver, options?: IntegrationsQueryOptions) {
  const baseUrl = resolveBaseUrl();
  const api = useMemo(() => createSharedApi(() => baseUrl), [baseUrl]);
  return useQuery({
    queryKey: sharedQueryKeys.integrationsStatus(baseUrl),
    queryFn: api.integrationsStatus,
    ...options,
  });
}

export function useDebugStatsQuery(resolveBaseUrl: BaseUrlResolver, options?: DebugStatsQueryOptions) {
  const baseUrl = resolveBaseUrl();
  const api = useMemo(() => createSharedApi(() => baseUrl), [baseUrl]);
  return useQuery({
    queryKey: sharedQueryKeys.debugStats(baseUrl),
    queryFn: api.debugStats,
    ...options,
  });
}
