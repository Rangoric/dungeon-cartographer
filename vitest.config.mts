import { defineConfig, type Plugin } from "vitest/config";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

/**
 * Mirrors esbuild.config.mjs's `loader: { ".md": "text", ".base": "text" }`
 * - Vite/Vitest has no built-in equivalent (it only understands JS/TS by
 * default), and `settingsDefaults.ts` imports the settings-defaults files
 * as raw text, so those imports need the same treatment here or the
 * plugin-entry smoke test fails trying to parse markdown as JS.
 */
function rawTextPlugin(): Plugin {
  return {
    name: "raw-text-settings-defaults",
    transform(_code, id) {
      if (id.endsWith(".md") || id.endsWith(".base")) {
        return `export default ${JSON.stringify(readFileSync(id, "utf-8"))};`;
      }
    },
  };
}

export default defineConfig({
  plugins: [rawTextPlugin()],
  resolve: {
    alias: {
      // `obsidian` is provided by the app at runtime and isn't a real package,
      // so point it at our lightweight mock during tests.
      obsidian: fileURLToPath(new URL("./test/mocks/obsidian.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
