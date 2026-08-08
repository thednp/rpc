import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import rpc from "@thednp/rpc";

export default defineConfig({
  plugins: [solid({ ssr: true }), rpc()],
});
