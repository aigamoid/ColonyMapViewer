import { defineConfig } from "vite";

// GitHub Pages ではリポジトリ名がサブパスになるため base を切り替える。
// 環境変数 GH_PAGES_BASE があればそれを使用（CI から注入）。
export default defineConfig({
  base: process.env.GH_PAGES_BASE ?? "/",
  build: {
    target: "es2022",
    sourcemap: true,
  },
  server: {
    host: true,
  },
});
