"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTool = registerTool;
exports.getTool = getTool;
exports.listTools = listTools;
const tools = new Map();
function registerTool(tool) {
    tools.set(tool.name, tool);
}
function getTool(name) {
    return tools.get(name);
}
function listTools() {
    return Array.from(tools.keys());
}
