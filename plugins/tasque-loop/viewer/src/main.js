import { createApp } from "vue";
import "../vendor/lutica/tokens.css";
import "../vendor/lutica/bundle.css";
import "./style.css";
import App from "./App.vue";

/**
 * render-review.mjs が埋め込んだレビュー用のデータを読む。
 * 埋め込まれていない（vite dev で開いた）ときは、開発用のサンプルを使う。
 */
async function loadData() {
  const text = document.getElementById("tasque-review-data")?.textContent ?? "";
  if (text.trim().startsWith("{")) return JSON.parse(text);
  if (import.meta.env.DEV) return (await import("./sample.json")).default;
  throw new Error("レビュー用のデータが埋め込まれていない");
}

loadData()
  .then((data) => createApp(App, { data }).mount("#app"))
  .catch((e) => {
    const p = document.createElement("p");
    p.className = "lu-alert lu-alert--danger";
    p.textContent = `表示できない: ${e.message}`;
    document.getElementById("app").replaceChildren(p);
  });
