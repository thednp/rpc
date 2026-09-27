import { createServerFunction } from "@thednp/rpc/server";

export const getUsers = createServerFunction("get-users", async () => ({
  users: ["artae"],
}));
