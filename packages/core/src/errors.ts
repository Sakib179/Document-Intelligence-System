export class ServiceError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number, message: string) { super(message); }
}
