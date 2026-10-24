import { EventType, IncrementalSource, type eventWithTime } from "@rrweb/types";
import { describe, expect, it } from "vitest";

import { createReplayEventSanitizer, sanitizeReplayEvent } from "../replay-event-sanitizer";

const event = (value: unknown) => value as eventWithTime;

describe("sanitizeReplayEvent", () => {
  it("redacts credentials in the Meta href and snapshot attributes", () => {
    const meta = sanitizeReplayEvent(
      event({
        type: EventType.Meta,
        timestamp: 1,
        data: { href: "https://app.test/?access_token=synthetic-access-token", width: 1, height: 1 },
      }),
    );
    const snapshot = sanitizeReplayEvent(
      event({
        type: EventType.FullSnapshot,
        timestamp: 2,
        data: {
          initialOffset: { top: 0, left: 0 },
          node: {
            type: 0,
            id: 1,
            childNodes: [
              { type: 2, id: 2, tagName: "a", attributes: { href: "/x?_proxy_token=synthetic-proxy-token" }, childNodes: [] },
              {
                type: 2,
                id: 3,
                tagName: "img",
                attributes: { srcset: "/a.png?sig=synthetic-sig 1x, /b.png 2x" },
                childNodes: [],
              },
              { type: 2, id: 4, tagName: "input", attributes: { type: "hidden", value: "synthetic-csrf" }, childNodes: [] },
              { type: 3, id: 5, textContent: "Open https://app.test/?token=synthetic-text-token" },
            ],
          },
        },
      }),
    );

    const json = JSON.stringify([meta, snapshot]);
    expect(json).not.toMatch(/synthetic-(access-token|proxy-token|sig|csrf|text-token)/);
    expect(json).toContain("%5Bredacted%5D");
    expect(json).toContain("/b.png 2x");
  });

  it("sanitizes added nodes, attribute changes and text changes in mutations", () => {
    const result = sanitizeReplayEvent(
      event({
        type: EventType.IncrementalSnapshot,
        timestamp: 3,
        data: {
          source: IncrementalSource.Mutation,
          adds: [
            {
              parentId: 1,
              nextId: null,
              node: { type: 2, id: 9, tagName: "iframe", attributes: { src: "/e?token=synthetic-a" }, childNodes: [] },
            },
          ],
          attributes: [{ id: 2, attributes: { href: "/y?code=synthetic-b" } }],
          texts: [{ id: 5, value: "/cb?state=synthetic-c" }],
          removes: [],
        },
      }),
    );

    expect(JSON.stringify(result)).not.toMatch(/synthetic-[abc]/);
  });

  it("bounds and redacts custom and plugin payloads", () => {
    const custom = sanitizeReplayEvent(
      event({ type: EventType.Custom, timestamp: 4, data: { tag: "t".repeat(500), payload: { password: "synthetic-pw" } } }),
    ) as { data: { tag: string; payload: unknown } };
    const plugin = sanitizeReplayEvent(
      event({ type: EventType.Plugin, timestamp: 5, data: { plugin: "console", payload: { token: "synthetic-tk" } } }),
    );

    expect(custom.data.tag).toHaveLength(128);
    expect(JSON.stringify([custom, plugin])).not.toMatch(/synthetic-(pw|tk)/);
  });

  it("masks value-only attribute mutations of hidden, password and unknown nodes", () => {
    const sanitizer = createReplayEventSanitizer();
    sanitizer.sanitize(
      event({
        type: EventType.FullSnapshot,
        timestamp: 1,
        data: {
          initialOffset: { top: 0, left: 0 },
          node: {
            type: 0,
            id: 1,
            childNodes: [
              { type: 2, id: 2, tagName: "input", attributes: { type: "hidden", value: "" }, childNodes: [] },
              { type: 2, id: 3, tagName: "input", attributes: { type: "password" }, childNodes: [] },
              { type: 2, id: 4, tagName: "input", attributes: { type: "text" }, childNodes: [] },
            ],
          },
        },
      }),
    );
    const mutation = sanitizer.sanitize(
      event({
        type: EventType.IncrementalSnapshot,
        timestamp: 2,
        data: {
          source: IncrementalSource.Mutation,
          adds: [],
          removes: [],
          texts: [],
          attributes: [
            { id: 2, attributes: { value: "synthetic-hidden-changed" } },
            { id: 3, attributes: { value: "synthetic-password-changed" } },
            { id: 99, attributes: { value: "synthetic-context-missing" } },
            { id: 4, attributes: { type: "hidden", value: "synthetic-became-hidden" } },
          ],
        },
      }),
    );
    const input = sanitizer.sanitize(
      event({ type: EventType.IncrementalSnapshot, timestamp: 3, data: { source: IncrementalSource.Input, id: 98, text: "synthetic-input-unknown", isChecked: false } }),
    );

    const json = JSON.stringify([mutation, input]);
    expect(json).not.toMatch(/synthetic-(hidden-changed|password-changed|context-missing|became-hidden|input-unknown)/);
    expect(json).toContain("*".repeat("synthetic-hidden-changed".length));
  });

  it("keeps a visible input's value when its context is known and the policy allowed it", () => {
    const sanitizer = createReplayEventSanitizer();
    sanitizer.sanitize(
      event({
        type: EventType.FullSnapshot,
        timestamp: 1,
        data: { initialOffset: { top: 0, left: 0 }, node: { type: 2, id: 4, tagName: "input", attributes: { type: "text" }, childNodes: [] } },
      }),
    );
    const result = sanitizer.sanitize(
      event({ type: EventType.IncrementalSnapshot, timestamp: 2, data: { source: IncrementalSource.Input, id: 4, text: "visible", isChecked: false } }),
    );
    expect((result.data as { text: string }).text).toBe("visible");
  });

  it("redacts credentials in every CSS and URL-bearing channel and keeps the CSS intact", () => {
    const events = [
      // _cssText and rr_src in a snapshot
      {
        type: EventType.FullSnapshot,
        timestamp: 1,
        data: {
          initialOffset: { top: 0, left: 0 },
          node: {
            type: 0,
            id: 1,
            childNodes: [
              { type: 2, id: 2, tagName: "style", attributes: { _cssText: ".a { background: url(/bg.png?token=synthetic-csstext); }" }, childNodes: [] },
              { type: 2, id: 3, tagName: "iframe", attributes: { rr_src: "https://embed.test/?access_token=synthetic-rrsrc" }, childNodes: [] },
              { type: 3, id: 4, textContent: "@import 'theme.css?key=synthetic-import';" },
            ],
          },
        },
      },
      // structured style diff and string style in an attribute mutation
      {
        type: EventType.IncrementalSnapshot,
        timestamp: 2,
        data: {
          source: IncrementalSource.Mutation,
          adds: [],
          removes: [],
          texts: [],
          attributes: [
            { id: 5, attributes: { style: { "background-image": "url('img.png?sig=synthetic-diff')", color: false } } },
            { id: 6, attributes: { style: { background: ["url(\"x.png?secret=synthetic-priority\")", "important"] } } },
            { id: 7, attributes: { style: "background:url(a.png?_proxy_token=synthetic-style)" } },
            { id: 8, attributes: { rr_src: "/frame?code=synthetic-rrsrc-mutation" } },
          ],
        },
      },
      // CSSOM insertRule / replaceSync
      {
        type: EventType.IncrementalSnapshot,
        timestamp: 3,
        data: {
          source: IncrementalSource.StyleSheetRule,
          id: 2,
          adds: [{ rule: ".b { background: url(b.png?token=synthetic-rule); }", index: 0 }, { rule: 42 }],
          replaceSync: ".c { background: url(c.png?api_key=synthetic-replace); }",
        },
      },
      // CSSStyleDeclaration.setProperty
      {
        type: EventType.IncrementalSnapshot,
        timestamp: 4,
        data: {
          source: IncrementalSource.StyleDeclaration,
          id: 2,
          index: [0],
          set: { property: "background", value: "url(d.png?jwt=synthetic-declaration)", priority: undefined },
        },
      },
      // adopted stylesheets
      {
        type: EventType.IncrementalSnapshot,
        timestamp: 5,
        data: {
          source: IncrementalSource.AdoptedStyleSheet,
          id: 1,
          styleIds: [1],
          styles: [{ styleId: 1, rules: [{ rule: ".e { background: url(e.png?password=synthetic-adopted); }", index: 0 }] }],
        },
      },
    ].map((value) => sanitizeReplayEvent(event(value)));

    const json = JSON.stringify(events);
    expect(json).not.toMatch(/synthetic-/);
    expect(json).toContain(".a { background: url(/bg.png?token=%5Bredacted%5D); }");
    expect(json).toContain("\"color\":false");
    expect(json).toContain("\"important\"");
    // A rule of the wrong shape is dropped, never passed through.
    expect((events[2]!.data as { adds: unknown[] }).adds).toHaveLength(1);
  });

  it("does not modify the original event", () => {
    const original = event({ type: EventType.Meta, timestamp: 1, data: { href: "/?token=synthetic", width: 1, height: 1 } });
    sanitizeReplayEvent(original);
    expect((original as { data: { href: string } }).data.href).toBe("/?token=synthetic");
  });
});
