import { createServerFunction } from "@thednp/rpc/server";

export const uploadFile = createServerFunction(async () => ({
  uploaded: true,
}));
