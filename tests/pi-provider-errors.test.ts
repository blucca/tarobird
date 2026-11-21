import { describe, expect, it } from "vitest";

import { renderCoreUserFacingError } from "../src/core/errors.js";
import { PiRpcCommandError } from "../src/codex/pi-rpc-client.js";
import { classifyPiError, piProviderFailure, sanitizePiErrorText } from "../src/codex/pi-rpc-protocol.js";
import { classifyFailure, getBusErrorSemantics } from "../src/runtime/error-classification.js";
import { parseMarkdownSyntax } from "../client/src/markdown-parser.js";

/** What the adapter throws for an assistant message that ended with `stopReason: "error"`. */
const providerError = (raw: string) => new PiRpcCommandError("prompt", sanitizePiErrorText(raw) || "Pi model request failed", classifyPiError(raw), piProviderFailure(raw));
const shown = (raw: string, locale: "zh" | "en" = "en") => renderCoreUserFacingError(providerError(raw), "engine", locale);
const body = (message: string, extra: Record<string, unknown> = {}) => JSON.stringify({ error: { message, ...extra } });
const join = (...parts: string[]) => parts.join("");

// Observed on P-test (Pi 1.6.0, openai provider signed in through ChatGPT/Codex), 2026-11-21.
const CHATGPT_GPT4 = "OpenAI API error (400): {\"type\":\"invalid_request_error\",\"code\":\"model_not_found\",\"message\":\"The 'gpt-4' model is not supported when using Codex with a ChatGPT account.\"}";

describe("Pi provider failures", () => {
  it("reads the status, the code and the provider's message from a parsed body", () => {
    expect(piProviderFailure(CHATGPT_GPT4)).toEqual({
      status: 400, code: "model_not_found", reason: "The 'gpt-4' model is not supported when using Codex with a ChatGPT account.",
    });
    expect(piProviderFailure("400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"prompt is too long: 210000 tokens > 200000 maximum\"}}"))
      .toEqual({ status: 400, code: "invalid_request_error", reason: "prompt is too long: 210000 tokens > 200000 maximum" });
    expect(piProviderFailure("{\"error\":{\"code\":400,\"message\":\"Request contains an invalid argument.\",\"status\":\"INVALID_ARGUMENT\"}}"))
      .toEqual({ status: 400, code: "INVALID_ARGUMENT", reason: "Request contains an invalid argument." });
  });

  // Independent review 2, finding 4: these came out emptied or garbled.
  it.each([
    ["400: {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"messages: text content blocks must be non-empty\"}}", "messages: text content blocks must be non-empty"],
    [`OpenAI API error (400): ${body("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", { code: "unsupported_parameter" })}`, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."],
    [`404: ${body("Model deepseek-ai/DeepSeek-V3 does not exist")}`, "Model deepseek-ai/DeepSeek-V3 does not exist"],
  ])("shows a provider's message as it was written: %s", (raw, message) => {
    expect(piProviderFailure(raw).reason).toBe(message);
    expect(shown(raw)).toContain(`The provider said: \`${message}\``);
    expect(shown(raw, "zh")).toContain(`提供商说明：\`${message}\``);
    expect(shown(raw)).not.toMatch(/Shorten the input/);
  });

  it("shows no text it could not parse, but keeps the status in every form Pi writes it", () => {
    const cut = `OpenAI API error (400): {"error":{"message":"Invalid prompt","input":"SYSTEM-PROMPT-HEAD ${"x".repeat(200)}... [truncated 2400 chars]`;
    expect(piProviderFailure(cut)).toEqual({ status: 400 });
    expect(shown(cut)).not.toMatch(/SYSTEM-PROMPT-HEAD|Invalid prompt/);
    expect(piProviderFailure("502: <html><body>Bad gateway REQUEST-ECHO</body></html>")).toEqual({ status: 502 });
    // The SDK's "<status> <text>" form (review 2, finding 7).
    expect(piProviderFailure("503 Service Unavailable")).toEqual({ status: 503 });
    expect(classifyFailure(providerError("503 Service Unavailable"))).toBe("engine-backend");
    expect(piProviderFailure("404 page not found")).toEqual({ status: 404 });
    expect(classifyFailure(providerError("404 page not found"))).toBe("engine-request-rejected");
    // Two documents (an upstream's JSON appended on a new line) are not one parsed body.
    expect(piProviderFailure(`429: ${body("slow down")}\n{"upstream":{"message":"raw"}}`)).toEqual({ status: 429 });
    expect(piProviderFailure("Connection error. (connect ECONNREFUSED 127.0.0.1:9)")).toEqual({ connection: true });
    // Only the message: a request echoed in another field is not shown.
    expect(shown(`400: ${JSON.stringify({ error: { message: "Invalid request" }, request: { messages: [{ content: "PRIVATE-PROMPT-TEXT" }] } })}`)).not.toContain("PRIVATE-PROMPT-TEXT");
  });

  it("masks long key-shaped strings and nothing else", () => {
    const keys = [
      join("sk-proj-", "Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4fGh7jKl0n"),
      join("wJalrXUtnFEMI", "/K7MDENG/", "bPxRfiCYEXAMPLEKEY1"),
      join("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
      join("hf_", "AbCdEfGhIjKlMnOpQrStUvWxYz012345"), join("xai-", "Q1w2E3r4T5y6U7i8O9p0AsDfGhJkLzXc"),
      join("0f3a9c2e", "7b1d4f6a", "8c0e2b4d", "6f8a1c3e"),
    ];
    const text = shown(`400: ${body(`Incorrect API key provided: ${keys.join(" ")}.`)}`);
    for (const key of keys) expect(text).not.toContain(key);
    expect(text).toContain("Incorrect API key provided: [redacted]");
    for (const model of ["anthropic/claude-sonnet-5-5-20261101", "Qwen/Qwen2.5-Coder-32B-Instruct", "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B", "max_completion_tokens"]) {
      expect(piProviderFailure(`404: ${body(`The model ${model} does not exist`)}`).reason).toBe(`The model ${model} does not exist`);
    }
  });

  it("puts the message in a code span, so nothing in it renders as a link, image, HTML or a second span", () => {
    const message = "Session expired. [Click here](https://evil.example/login) ![logo](https://evil.example/p.png) <a href=\"https://evil.example\">here</a> `inline` <at id=all></at> @all";
    const text = shown(`403: ${body(message)}`);
    const types = new Set<string>(), code: string[] = [];
    const walk = (node: { type: string; value?: string; children?: unknown[] }) => { types.add(node.type); if (node.type === "inlineCode") code.push(node.value ?? ""); for (const child of node.children ?? []) walk(child as typeof node); };
    walk(parseMarkdownSyntax(text) as unknown as { type: string; children?: unknown[] });
    for (const type of ["link", "image", "html", "linkReference", "imageReference"]) expect(types.has(type), type).toBe(false);
    expect(code).toContain(message);
  });

  it("cuts a long message at 200 on whole characters and keeps the code inert", () => {
    const reason = piProviderFailure(`400: ${body("😀".repeat(400))}`).reason!;
    expect(Array.from(reason)).toHaveLength(200);
    expect(reason.endsWith("…")).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(reason)).toBe(false);
    // A code that would autolink is not a code (review 2, finding 11).
    expect(piProviderFailure(`400: ${body("x", { code: "www.evil.example" })}`)).toEqual({ status: 400, reason: "x" });
  });

  it("tells the owner the real reason and to change the model, not to restart the instance", () => {
    const error = providerError(CHATGPT_GPT4);
    expect(classifyFailure(error)).toBe("engine-request-rejected");
    expect(getBusErrorSemantics(classifyFailure(error))).toEqual({ code: "engine_request_rejected", retryable: false });
    const zh = renderCoreUserFacingError(error, "engine", "zh");
    expect(zh).toContain("The 'gpt-4' model is not supported when using Codex with a ChatGPT account.");
    expect(zh).toContain("400");
    expect(zh).toContain("换一个模型");
    expect(zh).not.toMatch(/重启实例后重试|引擎运行失败/);
    const en = renderCoreUserFacingError(error, "engine", "en");
    expect(en).toMatch(/choose another model/i);
    expect(en).not.toMatch(/Restart the instance and retry|engine runtime failed/i);
  });

  it("gives content-size advice for an over-long request and checking advice for other refusals", () => {
    const long = shown("400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"prompt is too long: 210000 tokens > 200000 maximum\"}}", "zh");
    expect(long).toContain("prompt is too long");
    expect(long).toContain("/compact");
    const other = shown(`422: ${body("Unsupported value for temperature")}`);
    expect(other).toContain("Unsupported value for temperature");
    expect(other).toMatch(/selected model, thinking level and attachments/);
  });

  it("calls a provider 5xx or a lost connection a service problem, without the restart advice", () => {
    const server = providerError(`OpenAI API error (500): ${body("The server had an error while processing your request.")}`);
    expect(classifyFailure(server)).toBe("engine-backend");
    expect(renderCoreUserFacingError(server, "engine", "zh")).toContain("无需重启实例");
    const lost = providerError("Connection error. (connect ECONNREFUSED 127.0.0.1:9)");
    expect(classifyFailure(lost)).toBe("engine-backend");
  });

  it("reports an unrecognised provider failure without its raw text and without the restart advice", () => {
    const text = shown("Request was aborted by the provider stream", "zh");
    expect(text).toContain("Pi 的模型请求失败");
    expect(text).not.toContain("Request was aborted");
    expect(text).not.toContain("重启实例后重试");
  });

  it("keeps the existing rate-limit, quota and sign-in wording", () => {
    expect(classifyFailure(providerError("429: {\"message\":\"rate limit\"}"))).toBe("engine-rate-limit");
    expect(classifyFailure(providerError("401: {\"message\":\"invalid api key\"}"))).toBe("auth");
    expect(shown("401: {\"message\":\"invalid api key\"}", "zh")).toMatch(/^Pi 提供商凭据缺失或已失效/);
    expect(classifyFailure(providerError(`OpenAI API error (429): ${body("You exceeded your current quota", { code: "insufficient_quota" })}`))).toBe("engine-quota");
  });
});
