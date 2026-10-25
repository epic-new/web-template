import "server-only";

import { isAllowedEpicUrl, resolveOtlpEndpoint } from "@/lib/replay/server/otlp-endpoint";
import {
  replayPublishingErrorBodySchema,
  type ReplayPublishingErrorCode,
} from "@/lib/replay/replay-upload-contract";

export type EpicIntegrationErrorCode =
  | "unauthorized"
  | "unavailable"
  | "invalid_response";

const ERROR_MESSAGES: Record<EpicIntegrationErrorCode, string> = {
  unauthorized: "Epic rejected the publishing credential",
  unavailable: "Epic is unavailable",
  invalid_response: "Epic returned an invalid response",
};

export class EpicIntegrationError extends Error {
  // `cause` keeps only the HTTP status, never the request, headers or body.
  constructor(
    public readonly code: EpicIntegrationErrorCode,
    status?: number,
  ) {
    super(
      ERROR_MESSAGES[code],
      status === undefined ? undefined : { cause: { status } },
    );
    this.name = "EpicIntegrationError";
  }
}

/**
 * A typed refusal from Epic's publishing routes (contract version 1): the exact HTTP
 * status, code and typed fields of the flat envelope. The message is fixed
 * text; Epic's own text, body and headers are never kept.
 */
export class EpicPublishingError extends Error {
  constructor(
    public readonly code: ReplayPublishingErrorCode,
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super("Epic refused the publishing request");
    this.name = "EpicPublishingError";
  }
}

const REQUEST_TIMEOUT_MS = 5_000;

type EpicEnv = Partial<Record<string, string | undefined>>;

/**
 * The configured Epic client for this deployment. The publishing credential
 * binds one project, application registration and environment; the client
 * never sends scope selectors of its own.
 */
export class EpicClient {
  readonly projectId: string;
  readonly #baseUrl: string;
  readonly #otlpUrl: string | null;
  readonly #token: string;
  readonly #protectionBypass: string | null;

  private constructor(
    baseUrl: string,
    otlpUrl: string | null,
    projectId: string,
    token: string,
    protectionBypass: string | null,
  ) {
    this.#baseUrl = baseUrl;
    this.#otlpUrl = otlpUrl;
    this.projectId = projectId;
    this.#token = token;
    this.#protectionBypass = protectionBypass;
  }

  static fromEnv(env: EpicEnv = process.env): EpicClient | null {
    const apiUrl = env.EPIC_API_URL;
    const projectId = env.EPIC_PROJECT_ID;
    const token = env.EPIC_PUBLISHING_TOKEN;
    if (!apiUrl || !projectId || !token) return null;

    let url: URL;
    try {
      url = new URL(apiUrl);
    } catch {
      return null;
    }

    if (!isAllowedEpicUrl(url, env)) return null;

    // A protected Epic (staging behind Vercel Deployment Protection) answers
    // every request with a login redirect unless it carries its bypass secret.
    const bypass = env.EPIC_VERCEL_PROTECTION_BYPASS?.trim() || null;
    return new EpicClient(url.origin, resolveOtlpEndpoint(env, url), projectId, token, bypass);
  }


  // The bypass secret belongs to the protected Epic only, never to another OTLP host.
  /** Whether telemetry has somewhere to go: `EPIC_OTLP_ENDPOINT` is unset (derived) or valid. */
  get otlpConfigured(): boolean {
    return this.#otlpUrl !== null;
  }

  #headers(extra: Record<string, string>, origin = this.#baseUrl): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#token}`,
      ...extra,
      ...(this.#protectionBypass && origin === this.#baseUrl
        ? { "x-vercel-protection-bypass": this.#protectionBypass }
        : {}),
    };
  }

  async request(path: string, { signal }: { signal?: AbortSignal } = {}): Promise<unknown> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method: "GET",
        headers: this.#headers({ Accept: "application/json" }),
        cache: "no-store",
        // The bearer token must never follow a redirect to another host.
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new EpicIntegrationError("unavailable");
    }

    if (response.status === 401 || response.status === 403) {
      throw new EpicIntegrationError("unauthorized", response.status);
    }
    if (!response.ok) {
      throw new EpicIntegrationError("unavailable", response.status);
    }

    try {
      return await response.json();
    } catch {
      throw new EpicIntegrationError("invalid_response", response.status);
    }
  }

  /**
   * POSTs a JSON body as the publishing credential. Only Authorization,
   * Content-Type, Accept and, when configured, the protection bypass are
   * sent: nothing from the incoming request (cookies,
   * origin, referrer, forwarding or User-Agent headers) can reach Epic.
   *
   * A non-2xx answer in Epic's flat error envelope becomes an
   * `EpicPublishingError`; anything else that fails is `unavailable`.
   */
  async post(
    path: string,
    body: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ status: number; body: unknown }> {
    return this.#send(`${this.#baseUrl}${path}`, body, options);
  }

  /**
   * POSTs OTLP/JSON to one signal of Epic's ingest (`/v1/logs`, ...) with the
   * same discipline as `post`: only the credential and content headers leave.
   */
  async postOtlp(
    signal: "logs" | "traces" | "metrics",
    body: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ status: number; body: unknown }> {
    if (!this.#otlpUrl) throw new EpicIntegrationError("unavailable");
    return this.#send(`${this.#otlpUrl}/v1/${signal}`, body, options);
  }

  async #send(
    url: string,
    body: unknown,
    { signal, timeoutMs = REQUEST_TIMEOUT_MS }: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ status: number; body: unknown }> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: this.#headers(
          { "Content-Type": "application/json", Accept: "application/json" },
          new URL(url).origin,
        ),
        body: JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new EpicIntegrationError("unavailable");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new EpicIntegrationError(response.ok ? "invalid_response" : "unavailable", response.status);
    }

    if (response.ok) return { status: response.status, body: payload };

    const envelope = replayPublishingErrorBodySchema.safeParse(payload);
    if (!envelope.success) throw new EpicIntegrationError("unavailable", response.status);
    const { code, retryAfterMs } = envelope.data;
    throw new EpicPublishingError(code, response.status, retryAfterMs);
  }

  toString(): string {
    return "EpicClient";
  }

  toJSON(): string {
    return "EpicClient";
  }
}
