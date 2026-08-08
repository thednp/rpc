import { renderToString } from "react-dom/server";
import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { App, fetchGreeting, greetingKey } from "./App";

export async function render(_url: string) {
  const queryClient = new QueryClient();

  await queryClient.prefetchQuery({
    queryKey: greetingKey,
    queryFn: fetchGreeting,
  });

  console.log(`SSR greeting "${queryClient.getQueryData(greetingKey)}"`);

  const html = renderToString(
    <QueryClientProvider client={queryClient}>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <App />
      </HydrationBoundary>
    </QueryClientProvider>,
  );

  const state = JSON.stringify(dehydrate(queryClient)).replace(
    /</g,
    "\\u003c",
  );

  return { html, state };
}
