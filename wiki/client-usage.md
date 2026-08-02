# Client Usage

Server functions, despite their name, work in both server and client side (transformed into `fetch` based modules by our plugin), a perfect fit for isomorphic rendering.

In most apps you will be working with client focused apps.

## Auto-Generated Client Modules

When you import from `./api` in your client code, the plugin intercepts the import and generates a client module for each server function.

```ts
import { sayHi, add } from './api';
```

Each imported function returns:

```ts
{ data: Promise<T>, cancel: (reason: string) => void }
```

- **`data`** — A promise that resolves to the server function's return value.
- **`cancel(reason: string)`** — Aborts the underlying fetch request, causing `signal.aborted` to be set in the server function.

### Example

```ts
import { sayHi } from './api';

const { data, cancel } = sayHi('World');
const result = await data; // "Hello World!"
cancel('user cancelled'); // triggers AbortController on the client side
```

## Error Handling

- **Fetch errors** (network failure, CORS) — thrown from `await data`
- **HTTP 4xx/5xx responses** — thrown from `await data`
- **Cancellation** — aborts the fetch and warns `"Request was cancelled"` in the console

## @tanstack/react-query Integration

`@thednp/rpc` is a transport pipe — it handles serialization and transport only. For client-side caching, data invalidation, and stale-while-revalidate patterns, use `@tanstack/react-query`:

```ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { sayHi } from './api';

function GreetUser({ name }: { name: string }) {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['say-hi', name],
    queryFn: ({ signal }) => {
      const result = sayHi(name);
      signal.addEventListener('abort', () => result.cancel('query cancelled'));
      return result.data;
    },
  });

  return <div>{data ?? 'Loading...'}</div>;
}
```

Combine `cancel()` with React Query's `signal` for proper abort handling during component unmount or query invalidation.

Other frameworks have a `@tanstack/<framework>-query` made by [Tanstack](https://tanstack.com/).
