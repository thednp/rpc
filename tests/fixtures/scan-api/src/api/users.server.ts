import { createServerFunction } from "@thednp/rpc/server";

export const getUsers = createServerFunction(async () => ({
  users: ["artae"],
}));
