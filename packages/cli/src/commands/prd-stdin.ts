export const MAX_OPERATOR_CONTEXT_BYTES = 256 * 1024;

class PrdStdinLimitError extends Error {
  public readonly code = "CCC_PRD_OPERATOR_CONTEXT_INVALID";

  public constructor(maxBytes: number) {
    super("typed operator context exceeds " + maxBytes + " bytes");
    this.name = "PrdStdinLimitError";
  }
}

export async function readBoundedPrdStdin(
  input: AsyncIterable<unknown>,
  maxBytes = MAX_OPERATOR_CONTEXT_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    totalBytes += bytes.byteLength;
    if (totalBytes > maxBytes) throw new PrdStdinLimitError(maxBytes);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}
