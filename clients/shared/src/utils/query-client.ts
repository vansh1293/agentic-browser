import { QueryClient } from "@tanstack/react-query";

export function createDefaultQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchInterval: 5000,
        retry: 1,
        staleTime: 2000,
      },
    },
  });
}
