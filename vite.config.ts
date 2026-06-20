import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Bundles ares-explorer.html + its TS/CSS/JS (including d3) into one self-contained
// HTML file in dist/, which the server serves as the ui:// resource. Single-file
// output keeps the host CSP simple — no external asset origins to allow.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: process.env.INPUT ?? "ares-explorer.html",
    },
  },
});
