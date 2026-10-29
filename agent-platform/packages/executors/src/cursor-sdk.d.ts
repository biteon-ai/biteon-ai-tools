declare module "@cursor/sdk" {
  export class CursorAgentError extends Error {
    isRetryable: boolean;
  }

  export interface CursorRunResult {
    status: string;
    id: string;
    result?: string;
  }

  export interface CursorRun {
    id?: string;
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
