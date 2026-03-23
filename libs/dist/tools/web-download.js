"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
// src/tools/web-download.ts
const fs_1 = require("fs");
const path = __importStar(require("path"));
const registry_js_1 = require("./registry.js");
(0, registry_js_1.registerTool)({
    name: "web.download",
    dangerLevel: "write",
    handler: async (input, ctx) => {
        const fetch = (await import("node-fetch")).default;
        const { buffer } = await import("stream/consumers");
        const url = (input?.url || "").toString().trim();
        if (!url)
            throw new Error("web.download: 'url' is required");
        if (!url.startsWith("http://") && !url.startsWith("https://"))
            throw new Error("web.download: only http/https URLs are allowed");
        const relPath = input?.path;
        if (!relPath)
            throw new Error("web.download: 'path' is required");
        if (path.isAbsolute(relPath) || relPath.includes(".."))
            throw new Error("web.download: path must be relative and not contain '..'");
        const absPath = path.resolve(ctx.cwd, relPath);
        const maxBytes = input?.maxBytes ?? 50 * 1024 * 1024;
        const overwrite = input?.overwrite ?? false;
        ctx.log(`[web.download] GET ${url} -> ${absPath} (maxBytes=${maxBytes}, overwrite=${overwrite})`);
        let exists = false;
        try {
            await fs_1.promises.access(absPath);
            exists = true;
        }
        catch {
            exists = false;
        }
        if (exists && !overwrite)
            throw new Error(`web.download: file already exists: ${relPath}`);
        await fs_1.promises.mkdir(path.dirname(absPath), { recursive: true });
        const res = await fetch(url);
        if (!res.ok || !res.body)
            throw new Error(`web.download: request failed with status ${res.status}`);
        const contentType = res.headers.get("content-type") || undefined;
        // Consomme le stream Node.js en buffer
        let fileData = await buffer(res.body);
        let truncated = false;
        if (fileData.length > maxBytes) {
            fileData = fileData.subarray(0, maxBytes);
            truncated = true;
        }
        await fs_1.promises.writeFile(absPath, fileData);
        const stat = await fs_1.promises.stat(absPath);
        return {
            url,
            path: relPath,
            absolutePath: absPath,
            size: stat.size,
            truncated,
            contentType,
        };
    },
});
