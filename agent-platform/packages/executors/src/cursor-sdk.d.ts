declare module "@cursor/sdk" {
  export class CursorAgentError extends Error {
    isRetryable: boolean;
  }

  export interface CursorRunResult {
    status: string;
    id: string;
    result?: string;
  }

  export type CursorStreamMessage =
    | {
        type: "assistant";
        message: { content: Array<{ type: "text"; text: string } | { type: "tool_use"; name: string }> };
      }
    | { type: "thinking"; text: string; thinking_duration_ms?: number }
    | { type: "tool_call"; name: string; status: "running" | "completed" | "error"; args?: unknown; result?: unknown }
    | { type: "status"; status: string; message?: string }
    | { type: "task"; status?: string; text?: string }
    | { type: string; [key: string]: unknown };

  export interface CursorRun {
    id?: string;
    supports?(operation: "stream" | "wait" | "cancel" | "conversation"): boolean;
    stream?(): AsyncGenerator<CursorStreamMessage, void>;
    wait(): Promise<CursorRunResult>;
  }

  export interface CursorAgent {
    agentId: string;
    send(prompt: string): Promise<CursorRun>;
    [Symbol.asyncDispose](): Promise<void>;
  }

  export class Agent {
    static create(options: {
      apiKey: string;
      model: { id: string };
      local: { cwd: string; settingSources?: string[] };
    }): Promise<CursorAgent>;
  }
}
