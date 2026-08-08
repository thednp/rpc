import { hydrate } from "solid-js/web";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { App } from "./App";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 60_000,
    },
  },
});

hydrate(
  () => (
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  ),
  document.getElementById("app") as HTMLElement,
);
