import "server-only";

import {
  parseReplayUploadError,
  REPLAY_PUBLISHING_ERROR_CODES,
  type ReplayPublishingErrorCode,
} from "@/lib/replay/replay-upload-contract";

export type EpicIntegrationErrorCode =
  | "unauthorized"
  | "unavailable"
  | "invalid_response"
  | "rejected";

const ERROR_MESSAGES: Record<EpicIntegrationErrorCode, string> = {
  unauthorized: "Epic rejected the publishing credential",
  unavailable: "Epic is unavailable",
  invalid_response: "Epic returned an invalid response",
  rejected: "Epic rejected the request",
};

/**
 * A typed central EPI-210 v1 publishing rejection: the HTTP status, the exact
 * code (case preserved, `REPLAY_CREDENTIAL_INVALID` stays uppercase) and its
 * typed fields. Never the message text, raw body or provider detail.
 */
export interface EpicRejection {
  status: number;
  code: ReplayPublishingErrorCode;
  expectedSequence?: number;
  retryAfterMs?: number;
}

export class EpicIntegrationError extends Error {
  // `cause` keeps only the HTTP status, never the request, headers or body.
  constructor(
    public readonly code: EpicIntegrationErrorCode,
    status?: number,
    public readonly rejection?: EpicRejection,
  ) {
    super(
      ERROR_MESSAGES[code],
      status === undefined ? undefined : { cause: { status } },
    );
    this.name = "EpicIntegrationError";
  }
}

const REQUEST_TIMEOUT_MS = 5_000;

const CENTRAL_CODES = new Set<string>(REPLAY_PUBLISHING_ERROR_CODES);

// Strict flat v1 envelope whose status matches its central code; else null.
function readRejection(status: number, payload: unknown): EpicRejection | null {
  const parsed = parseReplayUploadError(status, payload);
  if (!parsed || !CENTRAL_CODES.has(parsed.code)) return null;
  return {
    status,
    code: parsed.code as ReplayPublishingErrorCode,
    ...(parsed.expectedSequence === undefined ? {} : { expectedSequence: parsed.expectedSequence }),
    ...(parsed.retryAfterMs === undefined ? {} : { retryAfterMs: parsed.retryAfterMs }),
  };
}

type EpicEnv = Partial<Record<string, string | undefined>>;

/**
 * The configured Epic client for this deployment. The publishing credential
 * binds one project, application registration and environment; the client
 * never sends scope selectors of its own.
 */
export class EpicClient {
  readonly projectId: string;
  readonly #baseUrl: string;
  readonly #token: string;

  private constructor(baseUrl: string, projectId: string, token: string) {
    this.#baseUrl = baseUrl;
    this.projectId = projectId;
    this.#token = token;
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

    const isLocalHttp =
      url.protocol === "http:" &&
      url.hostname === "localhost" &&
      env.NODE_ENV !== "production";
    if (url.protocol !== "https:" && !isLocalHttp) return null;

    return new EpicClient(url.origin, projectId, token);
  }

  async request(path: string, { signal }: { signal?: AbortSignal } = {}): Promise<unknown> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: "application/json",
        },
        cache: "no-store",
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
   * POSTs JSON. The header set is built fresh and allowlisted: nothing from
   * the application's incoming request (cookies, origin, referrer, forwarding
   * or visitor user-agent headers) is ever copied. A non-2xx answer carrying
   * the strict flat central error envelope throws `rejected` with its typed
   * rejection; a network failure or timeout throws `unavailable`.
   */
  async post(
    path: string,
    body: unknown,
    { signal, timeoutMs = REQUEST_TIMEOUT_MS }: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ status: number; payload: unknown }> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new EpicIntegrationError("unavailable");
    }

    let payload: unknown = null;
    let parsed = true;
    try {
      payload = await response.json();
    } catch {
      parsed = false;
    }

    if (!response.ok) {
      const rejection = readRejection(response.status, payload);
      if (rejection) throw new EpicIntegrationError("rejected", response.status, rejection);
      if (response.status === 401 || response.status === 403) {
        throw new EpicIntegrationError("unauthorized", response.status);
      }
      throw new EpicIntegrationError("unavailable", response.status);
    }
    if (!parsed) throw new EpicIntegrationError("invalid_response", response.status);
    return { status: response.status, payload };
  }

  toString(): string {
    return "EpicClient";
  }

  toJSON(): string {
    return "EpicClient";
  }
}
