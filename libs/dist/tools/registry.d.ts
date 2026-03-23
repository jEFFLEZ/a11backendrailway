import type { RegisteredTool } from "./types";
export declare function registerTool(tool: RegisteredTool): void;
export declare function getTool(name: string): RegisteredTool | undefined;
export declare function listTools(): string[];
