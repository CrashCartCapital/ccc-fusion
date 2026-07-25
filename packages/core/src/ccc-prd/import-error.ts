export class CccPrdImportError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CccPrdImportError";
  }
}
