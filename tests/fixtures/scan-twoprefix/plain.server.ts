// Registers under whichever prefix the scan was configured with, because this
// function declares none of its own. Used to prove a second prefix can still
// be scanned after the first.
import { createServerFunction } from "../../../src/createFunction.ts";

export const plainFn = createServerFunction(
  "plainFn",
  async () => ({ data: "plain" }),
);
