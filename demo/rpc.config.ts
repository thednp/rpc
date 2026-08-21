// Import from the vite-free /config subpath — importing the main plugin
// entry here would drag Vite into the serverless function bundle.
import { defineConfig } from "@thednp/rpc/config";

export default defineConfig({
  rpcPrefix: "@demo",
});
