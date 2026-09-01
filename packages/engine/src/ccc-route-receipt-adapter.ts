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
        if (provider !== undefined && provider !== value) conflict = true;
        provider ??= value;
        return;
      }
      if (model !== undefined && model !== value) conflict = true;
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
        throw new Error("CCC SSE stream contains a conflicting terminal route receipt");
      }
      if (nonTerminalReceipt) {
        throw new Error("CCC SSE stream route receipt is not terminal");
      }
      if (provider === undefined && model === undefined) {
        throw new Error("CCC SSE stream terminal route receipt is missing");
      }
      if (!provider || !model) {
        throw new Error("CCC SSE stream terminal route receipt is incomplete");
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
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    const payload = await createReceiptAdapterPayload(model, context, options);
    const response = await fetch(`${model.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
      method: "POST",
      headers: createReceiptAdapterHeaders(model, options),
      body: JSON.stringify(payload),
      signal: requestController.signal,
    });
    responseBody = response.body ?? undefined;
    await options.onResponse?.({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
    }, model);
    if (!response.ok) {
      throw new Error(`CCC terminal route receipt provider returned HTTP ${response.status}`);
    }
    if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
      throw new Error("CCC terminal route receipt provider did not return text/event-stream");
    }
    if (!response.body) {
      throw new Error("CCC terminal route receipt provider returned no response body");
    }
    stream.push({ type: "start", partial: output as never });
    const completion = await consumeReceiptAdapterSse(
      response.body,
      receiptParser,
      stream,
      output,
      model,
    );
    if (requestController.signal.aborted || options.signal?.aborted === true) {
      throw new Error("CCC terminal route receipt request was aborted");
    }
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
    stream.push({ type: "error", reason: output.stopReason, error: output as never });
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

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      receiptParser.push(next.value);
      sseBuffer += decoder.decode(next.value, { stream: true });
      const { lines, remainder } = takeCompleteSseLines(sseBuffer);
      sseBuffer = remainder;
      for (const line of lines) consumeLine(line);
    }
  } finally {
    reader.releaseLock();
  }
  sseBuffer += decoder.decode();
  const { lines: finalLines } = takeCompleteSseLines(sseBuffer, true);
  for (const line of finalLines) consumeLine(line);
  if (dataLines.length > 0) consumeData(dataLines.join("\n"));

  finishTextBlock();
  finishThinkingBlock();
  finishToolCallBlocks();
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
