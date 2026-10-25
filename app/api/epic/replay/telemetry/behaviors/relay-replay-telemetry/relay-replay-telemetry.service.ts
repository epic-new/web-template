import "server-only";

import { z } from "zod";

import {
  EVIDENCE_ATTRIBUTES,
  RESOURCE_ATTRIBUTES,
  type OtlpLogsRequest,
} from "@/lib/replay/replay-otlp";
import {
  REPLAY_RELEASE_PATTERN,
  REPLAY_SESSION_ID_PATTERN,
  REPLAY_TELEMETRY_MAX_BYTES,
  REPLAY_TELEMETRY_MAX_RECORDS,
} from "@/lib/replay/replay-upload-contract";
import { deriveReplayCaptureContext, type UserAgentInfo } from "@/lib/replay/server/capture-context";
import { relayFailure } from "@/lib/replay/server/relay-failure";
import { ReplayUploadError } from "@/lib/replay/server/replay-upload-error";
import { deriveReplaySubject, type ReplayActor, replaySecret } from "@/lib/replay/server/replay-subject";
import { EpicClient } from "@/shared/integrations/epic/epic";
import { TelemetryResource } from "@/shared/integrations/epic/resources/telemetry.resource";

// Epic bounds its own ingest; leave room for its answer.
const RELAY_TIMEOUT_MS = 15_000;
const MAX_RESOURCES = 8;
const MAX_ATTRIBUTES = 32;

const stringValue = z.object({ stringValue: z.string().max(REPLAY_TELEMETRY_MAX_BYTES) });
const attribute = z.object({ key: z.string().min(1).max(256), value: stringValue });

const logRecord = z.object({
  timeUnixNano: z.string().regex(/^[0-9]{1,24}$/),
  severityNumber: z.number().int().min(0).max(24).optional(),
  severityText: z.string().max(16).optional(),
  body: stringValue,
  attributes: z.array(attribute).max(MAX_ATTRIBUTES),
});

const requestSchema = z.object({
  resourceLogs: z
    .array(
      z.object({
        resource: z.object({ attributes: z.array(attribute).max(MAX_ATTRIBUTES) }),
        scopeLogs: z
          .array(
            z.object({
              scope: z.object({ name: z.string().min(1).max(64) }),
              logRecords: z.array(logRecord).max(REPLAY_TELEMETRY_MAX_RECORDS),
            }),
          )
          .max(MAX_RESOURCES),
      }),
    )
    .min(1)
    .max(MAX_RESOURCES),
});

export interface RelayReplayTelemetryCommand {
  actor: ReplayActor | null;
  input: unknown;
  userAgent: UserAgentInfo;
}

/**
 * Relays one browser OTLP/JSON logs request to Epic's ingest as the
 * publishing credential. The browser's request is rebuilt, not forwarded:
 * a resource keeps only its session id and release, and the relay adds the
 * trusted visitor id and the coarse capture context. Scope attributes
 * (`epic.project.id`, `service.name`, ...) are Epic's to set from the token,
 * so nothing the browser sent for them survives. No cookie, address, full
 * User-Agent or request header goes upstream, and no record is stored or
 * logged here.
 */
export class RelayReplayTelemetry {
  static async execute(command: RelayReplayTelemetryCommand): Promise<void> {
    try {
      const input = requestSchema.parse(command.input);
      if (!command.actor) throw new ReplayUploadError("identity_required");

      const client = EpicClient.fromEnv();
      const secret = replaySecret();
      if (!client || !client.otlpConfigured || !secret) throw new ReplayUploadError("not_configured");

      const records = input.resourceLogs.reduce(
        (total, resource) =>
          total + resource.scopeLogs.reduce((sum, scope) => sum + scope.logRecords.length, 0),
        0,
      );
      if (records === 0) throw new ReplayUploadError("invalid_request", { status: 422 });
      if (records > REPLAY_TELEMETRY_MAX_RECORDS) throw new ReplayUploadError("payload_too_large");

      const context = RelayReplayTelemetry.contextAttributes(
        deriveReplaySubject(command.actor, secret),
        command.userAgent,
      );
      const request: OtlpLogsRequest = {
        resourceLogs: input.resourceLogs.map((resourceLogs) => ({
          resource: { attributes: RelayReplayTelemetry.resourceAttributes(resourceLogs.resource.attributes, context) },
          scopeLogs: resourceLogs.scopeLogs.map((scope) => ({
            scope: { name: scope.scope.name },
            logRecords: scope.logRecords.map((record) => ({
              ...record,
              attributes: record.attributes.filter(({ key }) => RelayReplayTelemetry.isRecordAttribute(key)),
            })),
          })),
        })),
      };
      await TelemetryResource.sendLogs(client, request, { timeoutMs: RELAY_TIMEOUT_MS });
    } catch (error) {
      throw relayFailure(error);
    }
  }

  // Only the session and the build identity are the browser's to say about itself.
  private static resourceAttributes(
    sent: { key: string; value: { stringValue: string } }[],
    context: { key: string; value: { stringValue: string } }[],
  ) {
    const value = (key: string) => sent.find((attribute) => attribute.key === key)?.value.stringValue;
    const sessionId = value(RESOURCE_ATTRIBUTES.sessionId);
    if (!sessionId || !REPLAY_SESSION_ID_PATTERN.test(sessionId)) {
      throw new ReplayUploadError("invalid_request", { status: 422 });
    }
    const release = value(RESOURCE_ATTRIBUTES.release);
    return [
      { key: RESOURCE_ATTRIBUTES.sessionId, value: { stringValue: sessionId } },
      ...(release && REPLAY_RELEASE_PATTERN.test(release)
        ? [{ key: RESOURCE_ATTRIBUTES.release, value: { stringValue: release } }]
        : []),
      ...context,
    ];
  }

  // A record attribute is the replay ordering (`rr-web.*`) or evidence (`epic.event`, ...); nothing else.
  private static isRecordAttribute(key: string): boolean {
    return key.startsWith("rr-web.") || (Object.values(EVIDENCE_ATTRIBUTES) as string[]).includes(key);
  }

  private static contextAttributes(subjectId: string, userAgent: UserAgentInfo) {
    const { browser, os, deviceClass } = deriveReplayCaptureContext(userAgent, null);
    const named = ({ name, majorVersion }: { name: string; majorVersion: string | null }) =>
      majorVersion ? `${name}/${majorVersion}` : name;
    return [
      { key: RESOURCE_ATTRIBUTES.subjectId, value: { stringValue: subjectId } },
      { key: RESOURCE_ATTRIBUTES.browser, value: { stringValue: named(browser) } },
      { key: RESOURCE_ATTRIBUTES.os, value: { stringValue: named(os) } },
      { key: RESOURCE_ATTRIBUTES.device, value: { stringValue: deviceClass } },
    ];
  }
}
