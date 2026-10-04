// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "../src/App.vue";

const KEYS = [
  "recon.server.v1",
  "recon.outbox.v1",
  "recon.conflicts.v1",
  "recon.prefs.v1",
  "recon.network.v1",
];

describe("App 挂载冒烟", () => {
  beforeEach(() => {
    KEYS.forEach((k) => localStorage.removeItem(k));
    sessionStorage.clear();
    document.body.innerHTML = '<div id="root"></div>';
  });
  afterEach(() => {
    document.body.innerHTML = "";
    KEYS.forEach((k) => localStorage.removeItem(k));
  });

  it("完整组件树可挂载并渲染班次核销台", () => {
    const app = createApp(App).use(createPinia());
    app.mount("#root");
    const text = document.body.textContent ?? "";
    expect(text).toContain("班次核销台");
    expect(text).toContain("油枪");
    expect(text).toContain("当班收入");
    expect(text).toContain("待核");
    expect(document.querySelectorAll("table").length).toBeGreaterThan(0);
  });
});
