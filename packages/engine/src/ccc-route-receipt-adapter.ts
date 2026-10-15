import {
  calculateCost,
  createAssistantMessageEventStream,
  parseStreamingJson,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";

export const CCC_TERMINAL_ROUTE_RECEIPT_API = "ccc-terminal-route-receipt.v1";

export type CccTerminalRouteReceiptObservation = Readonly<{
  provider: string;
  model: string;
}>;

export type CccTerminalRouteSseCommentParser = {
  push(chunk: string | Uint8Array): void;
  finish(): CccTerminalRouteReceiptObservation;
};

/*
FNXC:CccRouteReceiptFailureMarker 2026-10-14-17:37:
Errata E5-P1 item 4 (grant: an additive structural marker on error events). A planning session must tell a terminal-receipt failure from a lost connection, and both from the upstream's own error. The parser tags each terminal-receipt refusal with cccRouteFailure, and the adapter copies that tag, or cccTransportFailure: true for a terminated stream, socket reset, fetch failure or adapter timeout, onto the error event it emits. An upstream-reported error (an HTTP status or finish_reason error) and a caller abort carry neither field. The markers sit on the event only; the error message and the result message are unchanged.
*/
type CccTerminalRouteFailureKind =
  | "receipt-missing"
  | "receipt-conflicting"
  | "receipt-incomplete"
  | "receipt-not-terminal";

/*
FNXC:CccRouteReceiptFailureMarker 2026-10-14-18:38:
Errata E7-P item 4. A conflicting receipt is evidence of which routes the upstream announced, so the parser keeps, per field, the first value and the first value that disagreed with it, and a conflict's error carries them as cccRouteObserved; the adapter copies that onto the error event next to cccRouteFailure. The values are copied as announced; the planning seam picks the one that conflicts with the bound route and bounds its length.
*/
/** The receipt values announced for each field, in order: the first, then the first that disagreed with it. */
export type CccTerminalRouteObservedValues = Readonly<{
  provider: readonly string[];
  model: readonly string[];
}>;

/*
FNXC:CccRouteReceiptFailureMarker 2026-10-14-20:46:
Errata E8-P items 1 and 2 (card P1z). Two failures leave the route unverified without the parser ever judging a receipt: a body that fails to process after [DONE], and an HTTP 200 that is not text/event-stream, which is never read. Each is marked cccRouteFailure "receipt-missing", so the planning seam settles one route refusal and never retries, and the event also carries cccRouteFailureDetail naming which of the two it was. The parser's own failures carry no detail.
*/
type CccTerminalRouteFailureDetail = "receipt-not-terminal" | "non-sse-response";

function terminalRouteFailure(
  kind: CccTerminalRouteFailureKind,
  message: string,
  observed?: CccTerminalRouteObservedValues,
  detail?: CccTerminalRouteFailureDetail,
  cause?: unknown,
): Error {
  return Object.assign(
    cause === undefined ? new Error(message) : new Error(message, { cause }),
    { cccRouteFailure: kind },
    observed ? { cccRouteObserved: observed } : {},
    detail ? { cccRouteFailureDetail: detail } : {},
  );
}

function takeCompleteSseLines(value: string, final = false): {
  lines: string[];
  remainder: string;
} {
  const holdTrailingCarriageReturn = !final && value.endsWith("\r");
  const splittable = holdTrailingCarriageReturn ? value.slice(0, -1) : value;
  const parts = splittable.split(/\r\n|\r|\n/u);
  if (final) return { lines: parts, remainder: "" };
  return {
    lines: parts.slice(0, -1),
    remainder: `${parts.at(-1) ?? ""}${holdTrailingCarriageReturn ? "\r" : ""}`,
  };
}

export function createCccTerminalRouteSseCommentParser(): CccTerminalRouteSseCommentParser {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let provider: string | undefined;
  let model: string | undefined;
  let conflictingProvider: string | undefined;
  let conflictingModel: string | undefined;
  let conflict = false;
  let receiptObserved = false;
  let nonTerminalReceipt = false;
  let finished = false;

  const consumeLine = (line: string): void => {
    const match = line.match(/^:\s*x-omniroute-(provider|model)=(.*)$/iu);
    if (match) {
      receiptObserved = true;
      const field = match[1]!.toLowerCase();
      const value = match[2]!;
      if (field === "provider") {
        if (provider !== undefined && provider !== value) {
          conflict = true;
          conflictingProvider ??= value;
        }
        provider ??= value;
        return;
      }
      if (model !== undefined && model !== value) {
        conflict = true;
        conflictingModel ??= value;
      }
      model ??= value;
      return;
    }
    if (receiptObserved && line.startsWith("data:") && line.slice(5).trim() !== "[DONE]") {
      nonTerminalReceipt = true;
    }
  };

  const consumeBufferedLines = (): void => {
    const { lines, remainder } = takeCompleteSseLines(buffer);
    buffer = remainder;
    for (const line of lines) consumeLine(line);
  };

  return {
    push: (chunk) => {
      if (finished) throw new Error("CCC terminal route receipt parser is already finished");
      const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
      buffer += decoder.decode(bytes, { stream: true });
      consumeBufferedLines();
    },
    finish: () => {
      if (finished) throw new Error("CCC terminal route receipt parser is already finished");
      finished = true;
      buffer += decoder.decode();
      const { lines } = takeCompleteSseLines(buffer, true);
      for (const line of lines) consumeLine(line);
      if (conflict) {
        const announced = (first: string | undefined, conflicting: string | undefined) =>
          Object.freeze([first, conflicting].filter((value): value is string => value !== undefined));
        throw terminalRouteFailure(
          "receipt-conflicting",
          "CCC SSE stream contains a conflicting terminal route receipt",
          Object.freeze({ provider: announced(provider, conflictingProvider), model: announced(model, conflictingModel) }),
        );
      }
      if (nonTerminalReceipt) {
        throw terminalRouteFailure("receipt-not-terminal", "CCC SSE stream route receipt is not terminal");
      }
      if (provider === undefined && model === undefined) {
        throw terminalRouteFailure("receipt-missing", "CCC SSE stream terminal route receipt is missing");
      }
      if (!provider || !model) {
        throw terminalRouteFailure("receipt-incomplete", "CCC SSE stream terminal route receipt is incomplete");
      }
      return Object.freeze({ provider, model });
    },
  };
}

export function streamCccTerminalRouteReceipt(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions = {},
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output = createTransportOutput(model);
  void runCccTerminalRouteReceiptRequest(stream, output, model, context, options);
  return stream;
}

type TransportOutput = {
  role: "assistant";
  content: Array<Record<string, unknown>>;
  api: Api;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  timestamp: number;
  responseId?: string;
  responseModel?: string;
  errorMessage?: string;
  cleanupErrorMessage?: string;
};

function createTransportOutput(model: Model<Api>): TransportOutput {
  return {
    role: "assistant" as const,
    content: [] as Array<Record<string, unknown>>,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as "stop" | "length" | "toolUse" | "error" | "aborted",
    timestamp: Date.now(),
  };
}

async function runCccTerminalRouteReceiptRequest(
  stream: AssistantMessageEventStream,
  output: TransportOutput,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
): Promise<void> {
  const receiptParser = createCccTerminalRouteSseCommentParser();
  const requestController = new AbortController();
  const forwardAbort = () => requestController.abort(options.signal?.reason);
  const timeout = options.timeoutMs === undefined
    ? undefined
    : setTimeout(
      () => requestController.abort(new Error("CCC terminal route receipt request timed out")),
      options.timeoutMs,
    );
  let responseBody: ReadableStream<Uint8Array> | undefined;
  // Set when the connection itself failed: fetch rejected, the body read rejected, the stream ended without [DONE],
  // or processing the body failed before [DONE] (E7-P item 1).
  const transport = { failed: false };
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    const payload = await createReceiptAdapterPayload(model, context, options);
    const headers = createReceiptAdapterHeaders(model, options);
    const body = JSON.stringify(payload);
    let response: Response;
    try {
      response = await fetch(`${model.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
        method: "POST",
        headers,
        body,
        signal: requestController.signal,
      });
    } catch (fetchError) {
      transport.failed = true;
      throw fetchError;
    }
    responseBody = response.body ?? undefined;
    /*
    FNXC:CccRouteReceiptFailureMarker 2026-10-14-18:55:
    Residual (errata E7-P item 8, recorded, not changed). A missing API key (thrown before the request) and a throw from this onResponse hook (after the upstream answered, before its body is read) carry no marker, so the planning seam classifies them as the upstream's own error and settles provider-error-event. No one-line label change separates them: the seam has no local-failure class, and marking the hook's throw as a transport failure needs a try/catch around it.
    */
    await options.onResponse?.({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
    }, model);
    if (!response.ok) {
      throw new Error(`CCC terminal route receipt provider returned HTTP ${response.status}`);
    }
    // A non-2xx status above stays the upstream's own error; a 200 that is not SSE is never read, so its route is
    // unverified (E8-P item 2).
    if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
      throw terminalRouteFailure(
        "receipt-missing",
        "CCC terminal route receipt provider did not return text/event-stream",
        undefined,
        "non-sse-response",
      );
    }
    /*
    FNXC:CccRouteReceiptFailureMarker 2026-10-14-21:09:
    P1z repair 1 (E8-P item 2). A 2xx with no body (a 204 or 205 naming text/event-stream) is never read either, so its route is unverified: the same receipt-missing marker and non-sse-response detail as a non-SSE 200, settled once and never retried. Without the marker pi.ts read it as the upstream's own error and retried.
    */
    if (!response.body) {
      throw terminalRouteFailure(
        "receipt-missing",
        "CCC terminal route receipt provider returned no response body",
        undefined,
        "non-sse-response",
      );
    }
    stream.push({ type: "start", partial: output as never });
    const completion = await consumeReceiptAdapterSse(
      response.body,
      receiptParser,
      stream,
      output,
      model,
      transport,
    );
    if (requestController.signal.aborted || options.signal?.aborted === true) {
      throw new Error("CCC terminal route receipt request was aborted");
    }
    // A stream that ends without [DONE] was cut off, whatever its receipt says.
    if (!completion.sawDone) transport.failed = true;
    const receipt = receiptParser.finish();
    (output as TransportOutput & { omniRoute?: CccTerminalRouteReceiptObservation }).omniRoute = receipt;
    if (!completion.sawDone) {
      throw new Error("CCC terminal route receipt stream ended without [DONE]");
    }
    if (!completion.sawFinishReason) {
      throw new Error("CCC terminal route receipt stream ended without finish_reason");
    }
    if (output.stopReason === "error") {
      throw new Error(output.errorMessage ?? "Provider returned an error stop reason");
    }
    if (output.stopReason === "aborted") {
      throw new Error("CCC terminal route receipt request was aborted");
    }
    stream.push({ type: "done", reason: output.stopReason, message: output as never });
    stream.end();
  } catch (error) {
    const callerAborted = options.signal?.aborted === true;
    // Only the timeout aborts the request controller without a caller abort, so this is the adapter timeout.
    const timedOut = requestController.signal.aborted && !callerAborted;
    const routeFailure = (error as { cccRouteFailure?: unknown } | null)?.cccRouteFailure;
    const routeObserved = (error as { cccRouteObserved?: unknown } | null)?.cccRouteObserved;
    const routeFailureDetail = (error as { cccRouteFailureDetail?: unknown } | null)?.cccRouteFailureDetail;
    const marker = callerAborted
      ? {}
      : transport.failed || timedOut
        ? { cccTransportFailure: true as const }
        : typeof routeFailure === "string"
          ? {
            cccRouteFailure: routeFailure,
            ...(routeObserved === undefined ? {} : { cccRouteObserved: routeObserved }),
            ...(routeFailureDetail === undefined ? {} : { cccRouteFailureDetail: routeFailureDetail }),
          }
          : {};
    let abortReason = error;
    if (responseBody && !responseBody.locked) {
      try {
        await responseBody.cancel(error);
      } catch (cancelError) {
        output.cleanupErrorMessage = cancelError instanceof Error
          ? cancelError.message
          : String(cancelError);
        abortReason = new AggregateError(
          [error, cancelError],
          "CCC terminal route receipt request and response cleanup both failed",
        );
      }
    }
    if (!requestController.signal.aborted) requestController.abort(abortReason);
    if (options.signal?.aborted === true) output.stopReason = "aborted";
    else output.stopReason = "error";
    for (const block of output.content) delete block.partialArgs;
    output.errorMessage = error instanceof Error ? error.message : String(error);
    stream.push({ type: "error", reason: output.stopReason, error: output as never, ...marker } as never);
    stream.end();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

async function createReceiptAdapterPayload(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
): Promise<Record<string, unknown>> {
  const compat = resolvedReceiptAdapterCompat(model);
  let payload: Record<string, unknown> = {
    model: model.id,
    messages: convertMessages(model as never, context, compat as never),
    stream: true,
    stream_options: { include_usage: true },
    ...(options.maxTokens ? { [compat.maxTokensField]: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(context.tools && context.tools.length > 0
      ? {
        tools: context.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            ...(compat.supportsStrictMode !== false ? { strict: false } : {}),
          },
        })),
      }
      : {}),
  };
  const toolChoice = (options as SimpleStreamOptions & { toolChoice?: unknown }).toolChoice;
  if (toolChoice !== undefined) payload.tool_choice = toolChoice;
  if (model.reasoning && options.reasoning) {
    payload.reasoning_effort = model.thinkingLevelMap?.[options.reasoning] ?? options.reasoning;
  }
  const transformed = await options.onPayload?.(payload, model);
  if (transformed !== undefined) {
    if (!transformed || typeof transformed !== "object" || Array.isArray(transformed)) {
      throw new Error("CCC terminal route receipt payload must remain an object");
    }
    payload = transformed as Record<string, unknown>;
  }
  return payload;
}

function resolvedReceiptAdapterCompat(model: Model<Api>) {
  const declared = (model as Model<Api> & { compat?: Record<string, unknown> }).compat ?? {};
  return {
    supportsDeveloperRole: declared.supportsDeveloperRole === true,
    requiresAssistantAfterToolResult: declared.requiresAssistantAfterToolResult === true,
    requiresThinkingAsText: declared.requiresThinkingAsText === true,
    requiresReasoningContentOnAssistantMessages:
      declared.requiresReasoningContentOnAssistantMessages === true,
    requiresToolResultName: declared.requiresToolResultName === true,
    deferredToolsMode: declared.deferredToolsMode,
    supportsStrictMode: declared.supportsStrictMode !== false,
    maxTokensField: declared.maxTokensField === "max_tokens"
      ? "max_tokens" as const
      : "max_completion_tokens" as const,
  };
}

function createReceiptAdapterHeaders(model: Model<Api>, options: SimpleStreamOptions): Headers {
  const values = new Headers({ "content-type": "application/json" });
  for (const [name, value] of Object.entries(model.headers ?? {})) values.set(name, value);
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) values.delete(name);
    else values.set(name, value);
  }
  if (!values.has("authorization")) {
    if (!options.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
    values.set("authorization", `Bearer ${options.apiKey}`);
  }
  return values;
}

async function consumeReceiptAdapterSse(
  body: ReadableStream<Uint8Array>,
  receiptParser: CccTerminalRouteSseCommentParser,
  stream: AssistantMessageEventStream,
  output: TransportOutput,
  model: Model<Api>,
  transport: { failed: boolean },
): Promise<{ sawDone: boolean; sawFinishReason: boolean }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let dataLines: string[] = [];
  let sawDone = false;
  let sawFinishReason = false;
  let textBlock: { type: "text"; text: string } | undefined;
  let thinkingBlock: {
    type: "thinking";
    thinking: string;
    thinkingSignature?: string;
  } | undefined;
  type StreamingToolCall = {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    partialArgs?: string;
  };
  const toolCalls = new Map<string, StreamingToolCall>();
  const contentIndex = (block: object) => output.content.indexOf(block as never);

  const finishTextBlock = (): void => {
    if (!textBlock) return;
    stream.push({
      type: "text_end",
      contentIndex: contentIndex(textBlock),
      content: textBlock.text,
      partial: output as never,
    });
    textBlock = undefined;
  };

  const finishThinkingBlock = (): void => {
    if (!thinkingBlock) return;
    stream.push({
      type: "thinking_end",
      contentIndex: contentIndex(thinkingBlock),
      content: thinkingBlock.thinking,
      partial: output as never,
    });
    thinkingBlock = undefined;
  };

  const finishToolCallBlocks = (): void => {
    for (const block of toolCalls.values()) {
      block.arguments = parseStreamingJson(block.partialArgs);
      delete block.partialArgs;
      stream.push({
        type: "toolcall_end",
        contentIndex: contentIndex(block),
        toolCall: block as never,
        partial: output as never,
      });
    }
    toolCalls.clear();
  };

  const consumeData = (data: string): void => {
    if (data === "[DONE]") {
      sawDone = true;
      return;
    }
    const chunk = JSON.parse(data) as Record<string, unknown>;
    if (typeof chunk.id === "string" && chunk.id.length > 0) output.responseId ??= chunk.id;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = choices[0] as Record<string, unknown> | undefined;
    const delta = choice?.delta && typeof choice.delta === "object"
      ? choice.delta as Record<string, unknown>
      : undefined;
    const substantive = choice?.finish_reason != null
      || (typeof delta?.content === "string" && delta.content.length > 0)
      || Array.isArray(delta?.tool_calls);
    if (
      substantive
      && typeof chunk.model === "string"
      && chunk.model.length > 0
      && chunk.model !== model.id
    ) output.responseModel ??= chunk.model;
    if (chunk.usage && typeof chunk.usage === "object") {
      output.usage = parseReceiptAdapterUsage(chunk.usage as Record<string, unknown>, model);
    }
    if (!choice) return;
    if (choice.finish_reason != null) {
      const mapped = mapReceiptAdapterStopReason(choice.finish_reason);
      output.stopReason = mapped.stopReason;
      if (mapped.errorMessage) output.errorMessage = mapped.errorMessage;
      sawFinishReason = true;
    }
    if (!delta) return;
    if (typeof delta.content === "string" && delta.content.length > 0) {
      finishThinkingBlock();
      finishToolCallBlocks();
      if (!textBlock) {
        textBlock = { type: "text", text: "" };
        output.content.push(textBlock);
        stream.push({ type: "text_start", contentIndex: contentIndex(textBlock), partial: output as never });
      }
      textBlock.text += delta.content;
      stream.push({
        type: "text_delta",
        contentIndex: contentIndex(textBlock),
        delta: delta.content,
        partial: output as never,
      });
    }
    const reasoning = ["reasoning_content", "reasoning", "reasoning_text"]
      .map((field) => [field, delta[field]] as const)
      .find((entry): entry is readonly [string, string] =>
        typeof entry[1] === "string" && entry[1].length > 0);
    if (reasoning) {
      finishTextBlock();
      finishToolCallBlocks();
      if (!thinkingBlock) {
        thinkingBlock = {
          type: "thinking",
          thinking: "",
          thinkingSignature: reasoning[0],
        };
        output.content.push(thinkingBlock);
        stream.push({ type: "thinking_start", contentIndex: contentIndex(thinkingBlock), partial: output as never });
      }
      thinkingBlock.thinking += reasoning[1];
      stream.push({
        type: "thinking_delta",
        contentIndex: contentIndex(thinkingBlock),
        delta: reasoning[1],
        partial: output as never,
      });
    }
    if (Array.isArray(delta.tool_calls)) {
      finishTextBlock();
      finishThinkingBlock();
      for (const raw of delta.tool_calls) {
        if (!raw || typeof raw !== "object") continue;
        const candidate = raw as Record<string, unknown>;
        const explicitId = typeof candidate.id === "string" && candidate.id.length > 0
          ? candidate.id
          : undefined;
        const key = typeof candidate.index === "number"
          ? `index:${candidate.index}`
          : explicitId
            ? `id:${explicitId}`
            : toolCalls.size <= 1
              ? (toolCalls.keys().next().value ?? "implicit:0")
              : undefined;
        if (key === undefined) {
          throw new Error("Provider tool call delta omitted both index and id in an ambiguous multi-call stream");
        }
        const fn = candidate.function && typeof candidate.function === "object"
          ? candidate.function as Record<string, unknown>
          : undefined;
        let block = toolCalls.get(key);
        if (!block) {
          block = {
            type: "toolCall",
            id: typeof candidate.id === "string" ? candidate.id : "",
            name: typeof fn?.name === "string" ? fn.name : "",
            arguments: {},
            partialArgs: "",
          };
          toolCalls.set(key, block);
          output.content.push(block);
          stream.push({ type: "toolcall_start", contentIndex: contentIndex(block), partial: output as never });
        }
        if (!block.id && typeof candidate.id === "string") block.id = candidate.id;
        if (!block.name && typeof fn?.name === "string") block.name = fn.name;
        const argumentDelta = typeof fn?.arguments === "string" ? fn.arguments : "";
        block.partialArgs = (block.partialArgs ?? "") + argumentDelta;
        block.arguments = parseStreamingJson(block.partialArgs);
        stream.push({
          type: "toolcall_delta",
          contentIndex: contentIndex(block),
          delta: argumentDelta,
          partial: output as never,
        });
      }
    }
  };

  const consumeLine = (line: string): void => {
    if (line === "") {
      if (dataLines.length > 0) consumeData(dataLines.join("\n"));
      dataLines = [];
      return;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /u, ""));
  };

  /*
  FNXC:CccRouteReceiptFailureMarker 2026-10-14-18:38:
  Errata E7-P item 1. Any error raised while the body is being processed, before [DONE] was seen, means the adapter abandoned a stream whose outcome it never learned: a last data line cut mid-JSON at a clean end, a malformed data line mid-stream, or any other parse failure. It is marked as a transport failure before it is rethrown, so a planning session leaves the attempt dispatched_unknown instead of settling it as the upstream's own error. An upstream-reported error never passes through here: finish_reason error is recorded on the output and thrown only after [DONE].
  */
  /*
  FNXC:CccRouteReceiptFailureMarker 2026-10-14-20:46:
  Errata E8-P item 1 (card P1z). After [DONE] the upstream has answered, so a processing failure is no lost connection, but it is no upstream error either: it throws before the terminal receipt is checked, so the route was never verified. It is marked as a route failure (receipt-missing, detail receipt-not-terminal) and the planning seam settles one route refusal with no retry, as it does for a data line after a receipt. The message is the processing error's own and the original error is kept as the cause. Before [DONE] the transport rule above still applies.
  */
  const processBeforeDone = (process: () => void): void => {
    try {
      process();
    } catch (processError) {
      if (!sawDone) {
        transport.failed = true;
        throw processError;
      }
      throw terminalRouteFailure(
        "receipt-missing",
        processError instanceof Error ? processError.message : String(processError),
        undefined,
        "receipt-not-terminal",
        processError,
      );
    }
  };

  try {
    while (true) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (readError) {
        transport.failed = true;
        throw readError;
      }
      if (next.done) {
        break;
      }
      const chunk = next.value;
      processBeforeDone(() => {
        receiptParser.push(chunk);
        sseBuffer += decoder.decode(chunk, { stream: true });
        const { lines, remainder } = takeCompleteSseLines(sseBuffer);
        sseBuffer = remainder;
        for (const line of lines) consumeLine(line);
      });
    }
  } finally {
    reader.releaseLock();
  }
  processBeforeDone(() => {
    sseBuffer += decoder.decode();
    const { lines: finalLines } = takeCompleteSseLines(sseBuffer, true);
    for (const line of finalLines) consumeLine(line);
    if (dataLines.length > 0) consumeData(dataLines.join("\n"));

    finishTextBlock();
    finishThinkingBlock();
    finishToolCallBlocks();
  });
  return { sawDone, sawFinishReason };
}

function parseReceiptAdapterUsage(raw: Record<string, unknown>, model: Model<Api>) {
  const promptTokens = typeof raw.prompt_tokens === "number" ? raw.prompt_tokens : 0;
  const completionTokens = typeof raw.completion_tokens === "number" ? raw.completion_tokens : 0;
  const promptDetails = raw.prompt_tokens_details && typeof raw.prompt_tokens_details === "object"
    ? raw.prompt_tokens_details as Record<string, unknown>
    : {};
  const cacheRead = typeof promptDetails.cached_tokens === "number" ? promptDetails.cached_tokens : 0;
  const cacheWrite = typeof promptDetails.cache_write_tokens === "number" ? promptDetails.cache_write_tokens : 0;
  const usage = {
    input: Math.max(0, promptTokens - cacheRead - cacheWrite),
    output: completionTokens,
    cacheRead,
    cacheWrite,
    totalTokens: promptTokens + completionTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

function mapReceiptAdapterStopReason(reason: unknown): {
  stopReason: "stop" | "length" | "toolUse" | "error";
  errorMessage?: string;
} {
  if (reason === "stop" || reason === "end") return { stopReason: "stop" };
  if (reason === "length") return { stopReason: "length" };
  if (reason === "function_call" || reason === "tool_calls") return { stopReason: "toolUse" };
  return { stopReason: "error", errorMessage: `Provider finish_reason: ${String(reason)}` };
}
