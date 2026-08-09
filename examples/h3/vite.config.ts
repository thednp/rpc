import { defineConfig } from "vite";
import rpc from "@thednp/rpc";

export default defineConfig({
  plugins: [rpc()],
});