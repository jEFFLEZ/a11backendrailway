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
// src/tools/fs-patch.ts
const fs_1 = require("fs");
const path = __importStar(require("path"));
const registry_1 = require("./registry");
function ensureSafeRelativePath(p) {
    if (!p || typeof p !== "string") {
        throw new Error("fs.patch: 'path' must be a non-empty string");
    }
    if (path.isAbsolute(p)) {
        throw new Error("fs.patch: absolute paths are not allowed");
    }
    if (p.includes("..")) {
        throw new Error("fs.patch: paths containing '..' are not allowed");
    }
    return p;
}
(0, registry_1.registerTool)({
    name: "fs.patch",
    dangerLevel: "write",
    handler: async (input, ctx) => {
        const relPath = ensureSafeRelativePath(input?.path);
        const absPath = path.resolve(ctx.cwd, relPath);
        const originalSnippet = (input?.originalSnippet ?? "").toString();
        const newSnippet = (input?.newSnippet ?? "").toString();
        const occurrence = input?.occurrence ?? 1;
        const maxBytes = input?.maxBytes ?? 256 * 1024;
        if (!originalSnippet) {
            throw new Error("fs.patch: 'originalSnippet' is required");
        }
        if (occurrence < 1) {
            throw new Error("fs.patch: 'occurrence' must be >= 1");
        }
        ctx.log(`[fs.patch] ${absPath} occurrence=${occurrence}`);
        const stat = await fs_1.promises.stat(absPath);
        if (!stat.isFile()) {
            throw new Error(`fs.patch: not a file: ${relPath}`);
        }
        if (stat.size > maxBytes) {
            throw new Error(`fs.patch: file too large (${stat.size} bytes > ${maxBytes}). Increase maxBytes if needed.`);
        }
        const content = await fs_1.promises.readFile(absPath, "utf8");
        const sizeBefore = Buffer.byteLength(content, "utf8");
        let index = -1;
        let from = 0;
        for (let i = 0; i < occurrence; i++) {
            index = content.indexOf(originalSnippet, from);
            if (index === -1)
                break;
            from = index + originalSnippet.length;
        }
        if (index === -1) {
            throw new Error("fs.patch: originalSnippet not found at requested occurrence");
        }
        const before = content.slice(0, index);
        const after = content.slice(index + originalSnippet.length);
        const newContent = before + newSnippet + after;
        const sizeAfter = Buffer.byteLength(newContent, "utf8");
        await fs_1.promises.writeFile(absPath, newContent, "utf8");
        return {
            path: relPath,
            absolutePath: absPath,
            occurrence,
            replaced: true,
            sizeBefore,
            sizeAfter,
        };
    },
});
