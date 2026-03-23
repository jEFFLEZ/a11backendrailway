"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const registry_js_1 = require("./registry.js");
require("./web-search");
require("./fs-search");
(0, registry_js_1.registerTool)({
    name: "web.fetch",
    dangerLevel: "safe",
    handler: async (input, ctx) => {
        const fetch = (await import("node-fetch")).default;
        let JSDOM;
        try {
            JSDOM = (await import("jsdom")).JSDOM;
        }
        catch (e) {
            throw new Error("jsdom is required for web.fetch tool. Please install it with 'npm install jsdom'.");
        }
        const url = String(input?.url || "").trim();
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            throw new Error("Only http/https URLs are allowed");
        }
        ctx.log(`[web.fetch] GET ${url}`);
        const res = await fetch(url, { redirect: "follow" });
        const html = await res.text();
        const dom = new JSDOM(html);
        const text = dom.window.document.body?.textContent || "";
        const shortText = text.slice(0, 20000);
        return {
            ok: true,
            status: res.status,
            url: res.url,
            title: dom.window.document.title || "",
            text: shortText,
        };
    },
});
