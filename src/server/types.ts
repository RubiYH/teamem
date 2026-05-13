export type ToolResult<T = unknown> = {
  ok: true;
  data: T;
};

export type ToolError = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export type ToolResponse<T = unknown> = ToolResult<T> | ToolError;
