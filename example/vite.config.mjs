import { defineConfig } from "vite";
import consoleErrorChannel from "../src/plugin.mjs";

export default defineConfig({
  plugins: [consoleErrorChannel()],
});
