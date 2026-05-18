declare module 'pg' {
  export type QueryResult<Row = Record<string, unknown>> = {
    rows: Row[];
    rowCount: number | null;
  };

  export class Pool {
    constructor(config: { connectionString: string });
    query<Row = Record<string, unknown>>(
      text: string,
      values?: unknown[]
    ): Promise<QueryResult<Row>>;
    end(): Promise<void>;
  }
}
