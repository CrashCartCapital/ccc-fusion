import { LockRetryExhaustedError, retryOnLock } from "../lock-retry.js";

export type BoardCommandCustodyDependencies<Context> = {
  resolveContext(projectName?: string): Promise<Context>;
  closeContext(context: Context): Promise<void>;
  fail(error: unknown): never;
  exit(code: number): never;
};

export async function withBoardWriteCustody<Context, Result>(
  dependencies: BoardCommandCustodyDependencies<Context>,
  projectName: string | undefined,
  retryContext: { id: string; action: string },
  fn: (context: Context) => Promise<Result>,
): Promise<Result> {
  try {
    return await retryOnLock(
      async () => {
        const context = await dependencies.resolveContext(projectName);
        try {
          return await fn(context);
        } finally {
          await dependencies.closeContext(context);
        }
      },
      retryContext,
    );
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      dependencies.fail(error);
    }
    throw error;
  }
}

export async function resolveBoardContextWithCustody<Context>(
  dependencies: BoardCommandCustodyDependencies<Context>,
  projectName: string | undefined,
  id: string,
  action = "resolve project",
): Promise<Context> {
  try {
    return await retryOnLock(
      () => dependencies.resolveContext(projectName),
      { id, action },
    );
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      dependencies.fail(error);
    }
    throw error;
  }
}

export async function retryBoardCallWithCustody<Context, Result>(
  dependencies: BoardCommandCustodyDependencies<Context>,
  context: Context,
  id: string,
  action: string,
  op: () => Promise<Result>,
): Promise<Result> {
  try {
    return await retryOnLock(op, { id, action });
  } catch (error) {
    if (error instanceof LockRetryExhaustedError) {
      await dependencies.closeContext(context).catch(() => {});
      dependencies.fail(error);
    }
    throw error;
  }
}

export async function closeBoardContextAndExitWithCustody<Context>(
  dependencies: BoardCommandCustodyDependencies<Context>,
  context: Context,
  code: number,
): Promise<never> {
  await dependencies.closeContext(context).catch(() => {});
  dependencies.exit(code);
}
