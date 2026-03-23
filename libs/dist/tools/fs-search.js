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
// src/tools/fs-search.ts
const fs_1 = require("fs");
const path = __importStar(require("path"));
const registry_1 = require("./registry");
async function walkDir(dir, options) {
    const entries = await fs_1.promises.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (options.excludeDirs.has(entry.name))
                continue;
            const sub = await walkDir(full, options);
            files.push(...sub);
        }
        else if (entry.isFile()) {
            files.push(full);
        }
    }
    return files;
}
async function searchFile(filePath, pattern) {
    const content = await fs_1.promises.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const lowerPattern = pattern.toLowerCase();
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        if (lineText.toLowerCase().includes(lowerPattern)) {
            matches.push({
                file: filePath,
                line: i + 1,
                preview: lineText.trim().slice(0, 200),
            });
        }
    }
    return matches;
}
(0, registry_1.registerTool)({
    name: "fs.search",
    dangerLevel: "safe",
    handler: async (input, ctx) => {
        const pattern = (input?.pattern || "").toString().trim();
        if (!pattern) {
            throw new Error("fs.search: 'pattern' is required");
        }
        const root = path.resolve(ctx.cwd, input.root || ".");
        const maxResults = input.maxResults ?? 100;
        const includeExt = input.includeExtensions ?? [
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            ".json",
            ".md",
            ".txt",
            ".cjs",
            ".mjs"
        ];
        const excludeDirs = new Set(input.excludeDirs ?? ["node_modules", ".git", ".qflush", "dist", "build"]);
        ctx.log(`[fs.search] pattern="${pattern}" root="${root}"`);
        const allFiles = await walkDir(root, { excludeDirs });
        const filteredFiles = allFiles.filter((f) => {
            const ext = path.extname(f).toLowerCase();
            return includeExt.includes(ext);
        });
        const results = [];
        let truncated = false;
        for (const file of filteredFiles) {
            if (results.length >= maxResults) {
                truncated = true;
                break;
            }
            try {
                const fileMatches = await searchFile(file, pattern);
                for (const m of fileMatches) {
                    results.push(m);
                    if (results.length >= maxResults) {
                        truncated = true;
                        break;
                    }
                }
            }
            catch (e) {
                ctx.log(`[fs.search] error reading ${file}: ${e.message}`);
            }
        }
        // on renvoie les chemins relatifs à root pour que ce soit plus lisible
        const relResults = results.map((m) => ({
            ...m,
            file: path.relative(root, m.file),
        }));
        return {
            pattern,
            root,
            results: relResults,
            truncated,
        };
    },
});
