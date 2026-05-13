export type ValidationIssue = {
  path: string;
  code: 'missing' | 'invalid_type' | 'invalid_value';
  message: string;
};

export class EventValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super('Event validation failed');
    this.name = 'EventValidationError';
    this.issues = issues;
  }
}
