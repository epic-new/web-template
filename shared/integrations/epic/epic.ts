import "server-only";

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

  toString(): string {
    return "EpicClient";
  }

  toJSON(): string {
    return "EpicClient";
  }
}
