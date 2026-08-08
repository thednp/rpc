import { generateHydrationScript, renderToStringAsync } from "solid-js/web";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { App, fetchGreeting, greetingKey } from "./App";

export async function render(_url: string) {
  const queryClient = new QueryClient();

  await queryClient.prefetchQuery({
    queryKey: greetingKey,
    queryFn: fetchGreeting,
  });

  console.log(`SSR greeting "${queryClient.getQueryData(greetingKey)}"`);

  const html = await renderToStringAsync(
    () => (
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    ),
  );

  return { html, hydration: generateHydrationScript() };
}
