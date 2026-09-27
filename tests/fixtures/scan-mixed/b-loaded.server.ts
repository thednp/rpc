// The only module in this fixture that exports a server function. Its
// siblings (a-empty, c-empty) export nothing, so the scan must survive
// whichever order the directory is read in.
import { createServerFunction } from "../../../src/createFunction.ts";

export const survivor = createServerFunction(
  "survivor",
  async () => ({ data: "ok" }),
);
