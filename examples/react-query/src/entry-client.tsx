import { hydrateRoot } from "react-dom/client";
import {
  HydrationBoundary,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { DehydratedState } from "@tanstack/react-query";
import { App } from "./App";

const state = (
  window as Window & { __REACT_QUERY_STATE__?: DehydratedState }
).__REACT_QUERY_STATE__;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 60_000,
    },
  },
});

hydrateRoot(
  document.getElementById("app") as HTMLElement,
  <QueryClientProvider client={queryClient}>
    <HydrationBoundary state={state}>
      <App />
    </HydrationBoundary>
  </QueryClientProvider>,
);
