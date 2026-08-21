import { defineConfig } from "@thednp/rpc";

export default defineConfig({
  rpcPrefix: "public:rpc",
  adapter: "express",
  serverFiles: "glob",
});