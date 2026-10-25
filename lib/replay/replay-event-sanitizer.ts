import { EventType, IncrementalSource, type eventWithTime } from "@rrweb/types";

import { REDACTED, sanitizeCssText, sanitizeReplayPayload, sanitizeUrl } from "./replay-redaction";
import { parseReplayMarker } from "./replay-marker.contract";

/**
 * Sanitizes one rrweb event before it enters a buffer. rrweb has already
 * masked inputs and text and blocked private regions; this pass removes
 * credentials from URLs and CSS anywhere in the stream, masks hidden and
 * password input values that rrweb leaves alone, and bounds the free-form
 * payloads of custom and plugin events. Returns a copy.
 *
 * rrweb reports a changed `value` attribute as `{ id, attributes: { value } }`
 * with no tag or type, and does not mask hidden inputs even under
 * `maskAllInputs`. A sanitizer created with `createReplayEventSanitizer()`
 * remembers each node's tag and input type from the snapshot and mutations of
 * its boundary; a value whose node is hidden, a password, or unknown is
 * masked. Anything in a CSS or URL channel that does not have the expected
 * shape is dropped rather than passed through.
 */

const URL_ATTRIBUTES = new Set(["href", "src", "rr_src", "action", "formaction", "poster", "xlink:href", "data", "cite"]);
const SRCSET_ATTRIBUTES = new Set(["srcset", "imagesrcset"]);
const CSS_ATTRIBUTES = new Set(["style", "_csstext"]);
const SECRET_INPUT_TYPES = new Set(["hidden", "password"]);
const NODE_TYPE_ELEMENT = 2;
const NODE_TYPE_TEXT = 3;

type Json = Record<string, unknown>;
type NodeContext = { tag: string; type: string | null };

const maskValue = (value: string) => "*".repeat(value.length);
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null;

function sanitizeSrcset(value: string): string {
  return value
    .split(",")
    .map((candidate) => {
      const trimmed = candidate.trim();
      const space = trimmed.search(/\s/);
      return space === -1
        ? sanitizeUrl(trimmed)
        : `${sanitizeUrl(trimmed.slice(0, space))}${trimmed.slice(space)}`;
    })
    .join(", ");
}

// A structured style diff: `{ prop: value | [value, priority] | false }`.
function sanitizeStyleDiff(diff: Json) {
  for (const [property, value] of Object.entries(diff)) {
    if (value === false) continue;
    if (typeof value === "string") diff[property] = sanitizeCssText(value);
    else if (Array.isArray(value) && typeof value[0] === "string") {
      diff[property] = [sanitizeCssText(value[0]), typeof value[1] === "string" ? value[1] : ""];
    } else delete diff[property];
  }
}

function sanitizeAttributeValue(attributes: Json, name: string) {
  const value = attributes[name];
  const lower = name.toLowerCase();
  const isUrl = URL_ATTRIBUTES.has(lower) || SRCSET_ATTRIBUTES.has(lower);
  if (CSS_ATTRIBUTES.has(lower)) {
    if (typeof value === "string") attributes[name] = sanitizeCssText(value);
    else if (isObject(value) && !Array.isArray(value)) sanitizeStyleDiff(value);
    else if (value !== null) delete attributes[name];
  } else if (isUrl) {
    if (typeof value === "string") {
      attributes[name] = SRCSET_ATTRIBUTES.has(lower) ? sanitizeSrcset(value) : sanitizeUrl(value);
    } else if (value !== null) delete attributes[name];
  }
}

function sanitizeRules(rules: unknown): Json[] {
  if (!Array.isArray(rules)) return [];
  return rules.flatMap((rule) =>
    isObject(rule) && typeof rule.rule === "string" ? [{ ...rule, rule: sanitizeCssText(rule.rule) }] : [],
  );
}

export function createReplayEventSanitizer() {
  const nodes = new Map<number, NodeContext>();

  function remember(node: Json) {
    if (typeof node.id !== "number") return;
    if (node.type === NODE_TYPE_ELEMENT && typeof node.tagName === "string") {
      const attributes = isObject(node.attributes) ? node.attributes : {};
      nodes.set(node.id, {
        tag: node.tagName.toLowerCase(),
        type: typeof attributes.type === "string" ? attributes.type.toLowerCase() : null,
      });
    } else nodes.delete(node.id);
  }

  // Unknown context is treated as secret: a value never passes without proof
  // that its node is not a hidden or password input.
  function isSecretValue(id: unknown): boolean {
    const context = typeof id === "number" ? nodes.get(id) : undefined;
    if (!context) return true;
    return context.tag === "input" && context.type !== null && SECRET_INPUT_TYPES.has(context.type);
  }

  function sanitizeNode(node: Json) {
    remember(node);
    if (node.type === NODE_TYPE_ELEMENT && isObject(node.attributes)) {
      const attributes = node.attributes;
      for (const name of Object.keys(attributes)) sanitizeAttributeValue(attributes, name);
      // A serialized element always carries its context, so only proven
      // hidden or password inputs are masked here.
      if (typeof attributes.value === "string" && typeof node.id === "number" && nodes.has(node.id) && isSecretValue(node.id)) {
        attributes.value = maskValue(attributes.value);
      }
    }
    if (node.type === NODE_TYPE_TEXT && typeof node.textContent === "string") {
      node.textContent = sanitizeCssText(node.textContent);
    }
    if (Array.isArray(node.childNodes)) {
      for (const child of node.childNodes) if (isObject(child)) sanitizeNode(child);
    }
  }

  function sanitizeMutation(data: Json) {
    if (Array.isArray(data.adds)) {
      for (const add of data.adds) if (isObject(add) && isObject(add.node)) sanitizeNode(add.node);
    }
    if (Array.isArray(data.attributes)) {
      for (const mutation of data.attributes) {
        if (!isObject(mutation) || !isObject(mutation.attributes)) continue;
        const attributes = mutation.attributes;
        const context = typeof mutation.id === "number" ? nodes.get(mutation.id) : undefined;
        if (context && "type" in attributes) {
          context.type = typeof attributes.type === "string" ? attributes.type.toLowerCase() : null;
        }
        for (const name of Object.keys(attributes)) sanitizeAttributeValue(attributes, name);
        if (typeof attributes.value === "string" && isSecretValue(mutation.id)) {
          attributes.value = maskValue(attributes.value);
        }
      }
    }
    if (Array.isArray(data.texts)) {
      for (const text of data.texts) {
        if (isObject(text) && typeof text.value === "string") text.value = sanitizeCssText(text.value);
      }
    }
  }

  function sanitizeIncremental(data: Json) {
    switch (data.source) {
      case IncrementalSource.Mutation:
        sanitizeMutation(data);
        break;
      case IncrementalSource.Input:
        if (typeof data.text === "string" && isSecretValue(data.id)) data.text = maskValue(data.text);
        break;
      case IncrementalSource.StyleSheetRule:
        if ("adds" in data) data.adds = sanitizeRules(data.adds);
        for (const key of ["replace", "replaceSync"] as const) {
          if (key in data) data[key] = typeof data[key] === "string" ? sanitizeCssText(data[key]) : "";
        }
        break;
      case IncrementalSource.StyleDeclaration:
        if (isObject(data.set)) {
          const value = data.set.value;
          data.set.value = typeof value === "string" ? sanitizeCssText(value) : null;
        }
        break;
      case IncrementalSource.AdoptedStyleSheet:
        if (Array.isArray(data.styles)) {
          data.styles = data.styles.flatMap((style) =>
            isObject(style) ? [{ ...style, rules: sanitizeRules(style.rules) }] : [],
          );
        }
        break;
    }
  }

  return {
    sanitize(event: eventWithTime): eventWithTime | null {
      // Project Epic data before cloning: unknown metadata may contain cycles,
      // accessors or report text that must never enter a serialized event.
      if (event.type === EventType.Custom) {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(event.data, "tag");
          if (descriptor && !("value" in descriptor)) return null;
          if (typeof descriptor?.value === "string" && descriptor.value.startsWith("epic.")) {
            const parsed = parseReplayMarker(event.data);
            return parsed.success ? { type: EventType.Custom, timestamp: event.timestamp, data: parsed.marker } : null;
          }
        } catch { return null; }
      }
      const copy = JSON.parse(JSON.stringify(event)) as eventWithTime & { data: Json };
      const data = copy.data as Json;

      switch (copy.type) {
        case EventType.Meta:
          // The publishing contract carries a document URL without query or
          // fragment; redacted query values are still not part of that wire shape.
          if (typeof data.href === "string") data.href = sanitizeUrl(data.href).split(/[?#]/, 1)[0];
          break;
        case EventType.FullSnapshot:
          nodes.clear();
          if (isObject(data.node)) sanitizeNode(data.node);
          break;
        case EventType.IncrementalSnapshot:
          sanitizeIncremental(data);
          break;
        case EventType.Custom:
          // A custom toJSON implementation cannot manufacture an unvalidated
          // reserved tag while the generic event is copied.
          if (typeof data.tag === "string" && data.tag.startsWith("epic.")) {
            const parsed = parseReplayMarker(data);
            return parsed.success ? { type: EventType.Custom, timestamp: copy.timestamp, data: parsed.marker } : null;
          }
          data.tag = typeof data.tag === "string" ? data.tag.slice(0, 128) : "custom";
          data.payload = sanitizeReplayPayload(data.payload);
          break;
        case EventType.Plugin:
          data.payload = sanitizeReplayPayload(data.payload);
          break;
        case EventType.Asset:
          data.url = typeof data.url === "string" ? sanitizeUrl(data.url) : REDACTED;
          break;
      }
      return copy;
    },

    /** Forgets node context, e.g. when a boundary ends. */
    reset(): void {
      nodes.clear();
    },
  };
}

export type ReplayEventSanitizer = ReturnType<typeof createReplayEventSanitizer>;

/**
 * Stateless form for a single event: without a snapshot to learn from, every
 * value-only mutation and input value is treated as secret.
 */
export function sanitizeReplayEvent(event: eventWithTime): eventWithTime | null {
  return createReplayEventSanitizer().sanitize(event);
}
