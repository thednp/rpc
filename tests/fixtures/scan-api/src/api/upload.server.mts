import { createServerFunction } from "@thednp/rpc/server";

export const uploadFile = createServerFunction("upload-file", async () => ({
  uploaded: true,
}));
