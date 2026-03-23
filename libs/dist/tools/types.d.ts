export type ToolContext = {
    cwd: string;
    env: NodeJS.ProcessEnv;
    log: (msg: string) => void;
};
export type ToolInput = any;
export type ToolOutput = any;
export type ToolHandler = (input: ToolInput, ctx: ToolContext) => Promise<ToolOutput>;
export interface RegisteredTool {
    name: string;
    handler: ToolHandler;
    dangerLevel?: "safe" | "write" | "exec";
}
