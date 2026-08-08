import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import rpc from "@thednp/rpc";

export default defineConfig({
  plugins: [react(), rpc()],
});
