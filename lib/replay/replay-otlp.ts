/**
 * OTLP/JSON in ClickStack's session format. Browser-safe and pure: the
 * transport encodes rrweb events and evidence with it, and the relay checks
 * what arrives against the same attribute names.
 *
 * Each rrweb event is one log record in scope `rum.rr-web`: `timeUnixNano` is
 * the event's millisecond timestamp, the body its compact JSON, and the
 * `rr-web.*` attributes order it. An event larger than `maxChunkBytes` is
 * split on character boundaries into chunk records that share `rr-web.event`.
 */

export const REPLAY_SCOPE = "rum.rr-web";
export const EVIDENCE_SCOPE = "epic.evidence";

export const RESOURCE_ATTRIBUTES = {
  sessionId: "rum.sessionId",
  release: "service.version",
  subjectId: "epic.subject.id",
  browser: "epic.capture.browser",
  os: "epic.capture.os",
  device: "epic.capture.device",
} as const;

export const RRWEB_ATTRIBUTES = {
  offset: "rr-web.offset",
  event: "rr-web.event",
  chunk: "rr-web.chunk",
  totalChunks: "rr-web.total-chunks",
} as const;

export const EVIDENCE_ATTRIBUTES = {
  event: "epic.event",
  behaviorName: "epic.behavior.name",
  behaviorOccurrence: "epic.behavior.occurrence",
  route: "epic.route",
} as const;

export const EVIDENCE_EVENTS = {
  behaviorStarted: "behavior.started",
  behaviorSucceeded: "behavior.succeeded",
  behaviorFailed: "behavior.failed",
  browserError: "browser.error",
} as const;
export type EvidenceEventName = (typeof EVIDENCE_EVENTS)[keyof typeof EVIDENCE_EVENTS];

export const EVIDENCE_BODY_MAX_CHARS = 500;

export interface OtlpStringValue {
  stringValue: string;
}

export interface OtlpAttribute {
  key: string;
  value: OtlpStringValue;
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  severityNumber?: number;
  severityText?: string;
  body: OtlpStringValue;
  attributes: OtlpAttribute[];
}

export interface OtlpResourceLogs {
  resource: { attributes: OtlpAttribute[] };
  scopeLogs: { scope: { name: string }; logRecords: OtlpLogRecord[] }[];
}

export interface OtlpLogsRequest {
  resourceLogs: OtlpResourceLogs[];
}

/** A record with the scope it belongs to, as the transport queues it. */
export interface ScopedLogRecord {
  scope: string;
  record: OtlpLogRecord;
}

const encoder = new TextEncoder();

export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

function attribute(key: string, value: string | number): OtlpAttribute {
  return { key, value: { stringValue: String(value) } };
}

/**
 * Splits text into pieces of at most `maxBytes` UTF-8 bytes, cutting only
 * between characters, so no multi-byte character (or surrogate pair) is ever
 * divided across two chunks.
 */
export function splitUtf8(text: string, maxBytes: number): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new RangeError("maxBytes must be at least 4");
  if (text.length * 3 <= maxBytes || utf8Length(text) <= maxBytes) return [text];

  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index)!;
    const width = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (bytes + width > maxBytes) {
      chunks.push(text.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += width;
    index += codePoint > 0xffff ? 2 : 1;
  }
  chunks.push(text.slice(start));
  return chunks;
}

/** The nanosecond timestamp string of a millisecond epoch. */
export function toUnixNano(milliseconds: number): string {
  return `${Math.max(Math.trunc(milliseconds), 0)}000000`;
}

export interface EncodedReplayEvent {
  records: ScopedLogRecord[];
  /** UTF-8 bytes of each record's body. */
  bytes: number[];
}

/**
 * One rrweb event as its record(s). `reserve` hands out the session's next
 * offsets once the chunk count is known: each chunk takes the next offset, so
 * ordering by offset is total, and all chunks share one event index. It
 * returns null when the session is gone, and then nothing is encoded.
 */
export function encodeReplayEvent(
  event: { timestamp: number },
  {
    maxChunkBytes,
    reserve,
  }: {
    maxChunkBytes: number;
    reserve: (records: number) => { offset: number; event: number } | null;
  },
): EncodedReplayEvent | null {
  const chunks = splitUtf8(JSON.stringify(event), maxChunkBytes);
  const reserved = reserve(chunks.length);
  if (!reserved) return null;
  const records = chunks.map((chunk, index) => ({
    scope: REPLAY_SCOPE,
    record: {
      timeUnixNano: toUnixNano(event.timestamp),
      body: { stringValue: chunk },
      attributes: [
        attribute(RRWEB_ATTRIBUTES.offset, reserved.offset + index),
        attribute(RRWEB_ATTRIBUTES.event, reserved.event),
        attribute(RRWEB_ATTRIBUTES.chunk, index + 1),
        attribute(RRWEB_ATTRIBUTES.totalChunks, chunks.length),
      ],
    },
  }));
  return { records, bytes: chunks.map(utf8Length) };
}

export interface EvidenceInput {
  event: EvidenceEventName;
  at: number;
  route: string;
  body: string;
  behaviorName?: string;
  occurrence?: string;
}

/** A non-replay log record: evidence that does not depend on the session being recorded. */
export function encodeEvidence(input: EvidenceInput): ScopedLogRecord {
  const attributes = [
    attribute(EVIDENCE_ATTRIBUTES.event, input.event),
    attribute(EVIDENCE_ATTRIBUTES.route, input.route),
  ];
  if (input.behaviorName) attributes.push(attribute(EVIDENCE_ATTRIBUTES.behaviorName, input.behaviorName));
  if (input.occurrence) attributes.push(attribute(EVIDENCE_ATTRIBUTES.behaviorOccurrence, input.occurrence));
  const failed = input.event === EVIDENCE_EVENTS.behaviorFailed || input.event === EVIDENCE_EVENTS.browserError;
  return {
    scope: EVIDENCE_SCOPE,
    record: {
      timeUnixNano: toUnixNano(input.at),
      severityNumber: failed ? 17 : 9,
      severityText: failed ? "ERROR" : "INFO",
      body: { stringValue: input.body.slice(0, EVIDENCE_BODY_MAX_CHARS) },
      attributes,
    },
  };
}

/** The request body for one session's queued records, grouped by scope in first-seen order. */
export function buildLogsRequest({
  sessionId,
  release,
  records,
}: {
  sessionId: string;
  release: string | null;
  records: readonly ScopedLogRecord[];
}): OtlpLogsRequest {
  const resource = [attribute(RESOURCE_ATTRIBUTES.sessionId, sessionId)];
  if (release) resource.push(attribute(RESOURCE_ATTRIBUTES.release, release));

  const scopes = new Map<string, OtlpLogRecord[]>();
  for (const { scope, record } of records) {
    const list = scopes.get(scope);
    if (list) list.push(record);
    else scopes.set(scope, [record]);
  }
  return {
    resourceLogs: [
      {
        resource: { attributes: resource },
        scopeLogs: [...scopes].map(([name, logRecords]) => ({ scope: { name }, logRecords })),
      },
    ],
  };
}
