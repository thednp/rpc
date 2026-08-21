import { defineConfig } from '@thednp/rpc/config';

export default defineConfig({
  rpcPrefix: "public:rpc",
  adapter: "express",
  serverFiles: "glob",
});