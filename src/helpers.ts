// Client-side RPC sub-modules
export const handleResponse = async (response: Response) => {
  if (!response.ok) {
    if (response.status === 499 || response.status === 408) {
      return console.warn("Request was cancelled");
    }
    throw new Error("Fetch error: " + response.statusText);
  }
  const result = await response.json();
  if (result.error) throw new Error(result.error);
  return result.data;
};

export const innerModule = (
  body: BodyInit,
  headers: HeadersInit,
  preffix: string,
  name: string,
) => {
  const controller = new AbortController();
  const cancel = (reason: string) => controller.abort(reason);

  const fetcher = async () => {
    try {
      const response = await fetch(`/${preffix}/${name}`, {
        method: "POST",
        headers,
        credentials: "include",
        body,
        signal: controller.signal,
      });
      return await handleResponse(response);
    } catch (err) {
      throw err;
    }
  };

  return {
    data: fetcher(),
    cancel,
  };
};
