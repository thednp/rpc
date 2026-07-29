import type { Credentials } from "./types.d.ts";
import { FETCH_ERROR_PREFIX, REQUEST_CANCELLED } from "./constants.ts";

export const handleResponse = async (response: Response) => {
  if (!response.ok) {
    if (response.status === 499 || response.status === 408) {
      return console.warn(REQUEST_CANCELLED);
    }
    throw new Error(FETCH_ERROR_PREFIX + response.statusText);
  }
  const result = await response.json();
  if (result.error) throw new Error(result.error);
  return result.data;
};

export const innerModule = (
  body: BodyInit,
  headers: HeadersInit,
  credentials: Credentials,
  prefix: string,
  name: string,
) => {
  const controller = new AbortController();
  const cancel = (reason: string) => controller.abort(reason);

  const fetcher = async () => {
    try {
      const response = await fetch(`/${prefix}/${name}`, {
        method: "POST",
        headers,
        credentials,
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
