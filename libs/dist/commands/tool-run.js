"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runToolRun = runToolRun;
require("../tools/web");
const registry_js_1 = require("../tools/registry.js");
async function runToolRun(argv) {
    const name = argv[0];
    const inputJson = argv[1] || "{}";
    const tool = (0, registry_js_1.getTool)(name);
    if (!tool) {
        console.error(JSON.stringify({ error: "Unknown tool", name }));
        process.exit(1);
    }
    const input = JSON.parse(inputJson);
    const output = await tool.handler(input, {
        cwd: process.cwd(),
        env: process.env,
        log: (msg) => console.error("[tool]", msg),
    });
    console.log(JSON.stringify({ ok: true, name, output }, null, 2));
}
