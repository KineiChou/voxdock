export class DomainError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(code);
    this.name = "DomainError";
  }
}
