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
// src/tools/fs-write.ts
const fs_1 = require("fs");
const path = __importStar(require("path"));
const registry_1 = require("./registry");
function ensureSafeRelativePath(p) {
    if (!p || typeof p !== "string") {
        throw new Error("fs.write: 'path' must be a non-empty string");
    }
    if (path.isAbsolute(p)) {
        throw new Error("fs.write: absolute paths are not allowed");
    }
    if (p.includes("..")) {
        throw new Error("fs.write: paths containing '..' are not allowed");
    }
    return p;
}
(0, registry_1.registerTool)({
    name: "fs.write",
    dangerLevel: "write",
    handler: async (input, ctx) => {
        const relPath = ensureSafeRelativePath(input?.path);
        const mode = input?.mode ?? "upsert";
        const content = (input?.content ?? "").toString();
        if (!content && content !== "") {
            throw new Error("fs.write: 'content' must be provided");
        }
        const absPath = path.resolve(ctx.cwd, relPath);
        const dir = path.dirname(absPath);
        ctx.log(`[fs.write] ${absPath} mode=${mode}`);
        await fs_1.promises.mkdir(dir, { recursive: true });
        let exists = false;
        try {
            await fs_1.promises.access(absPath);
            exists = true;
        }
        catch {
            exists = false;
        }
        if (mode === "create" && exists) {
            throw new Error(`fs.write: file already exists: ${relPath}`);
        }
        if (mode === "overwrite" && !exists) {
            throw new Error(`fs.write: file does not exist: ${relPath}`);
        }
        await fs_1.promises.writeFile(absPath, content, "utf8");
        const stat = await fs_1.promises.stat(absPath);
        return {
            path: relPath,
            absolutePath: absPath,
            mode,
            created: !exists,
            overwritten: exists,
            size: stat.size,
        };
    },
});
