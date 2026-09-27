// Declares its own prefix, so a single scan registers it correctly regardless
// of the prefix the scan was configured with.
import { createServerFunction } from "../../../src/createFunction.ts";

export const taggedFn = createServerFunction(
  "taggedFn",
  async () => ({ data: "tagged" }),
  { rpcPrefix: "tagged:rpc" },
);
