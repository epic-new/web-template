import { EventType, type eventWithTime } from "@rrweb/types";
import { describe, expect, it } from "vitest";

import { REPLAY_RECORDING_LIMITS } from "../replay-config.contract";
import { createReplayMemoryBuffer } from "../replay-buffer";

const event = (type: EventType, size = 0) =>
  ({ type, timestamp: 1, data: { pad: "x".repeat(size) } }) as unknown as eventWithTime;

describe("createReplayMemoryBuffer", () => {
  it("drops whole older boundaries when over the byte bound", () => {
    const buffer = createReplayMemoryBuffer({ ...REPLAY_RECORDING_LIMITS, maxBufferBytes: 1_000 });
    buffer.push(event(EventType.Meta, 300), 1);
    buffer.push(event(EventType.FullSnapshot, 300), 1);
    buffer.push(event(EventType.Meta, 300), 2);
    buffer.push(event(EventType.FullSnapshot, 300), 2);

    expect(buffer.events().map((entry) => [entry.boundary, entry.event.type])).toEqual([
      [2, EventType.Meta],
      [2, EventType.FullSnapshot],
    ]);
    expect(buffer.byteSize()).toBeLessThanOrEqual(1_000);
  });

  it("drops a boundary that alone exceeds the bound and ignores the rest of it", () => {
    const buffer = createReplayMemoryBuffer({ ...REPLAY_RECORDING_LIMITS, maxBufferBytes: 500 });
    buffer.push(event(EventType.Meta, 100), 1);
    buffer.push(event(EventType.FullSnapshot, 600), 1);
    buffer.push(event(EventType.IncrementalSnapshot, 10), 1);

    expect(buffer.events()).toEqual([]);
    expect(buffer.isOverflowed(1)).toBe(true);
  });

  it("bounds the number of entries", () => {
    const buffer = createReplayMemoryBuffer({ ...REPLAY_RECORDING_LIMITS, maxBatchEvents: 1 });
    for (let boundary = 1; boundary <= 6; boundary++) {
      buffer.push(event(EventType.Meta), boundary);
      buffer.push(event(EventType.FullSnapshot), boundary);
    }

    expect(buffer.events().length).toBeLessThanOrEqual(10);
    expect(buffer.events()[0]!.event.type).toBe(EventType.Meta);
  });

  it("bounds the UTF-8 size of the serialized buffer, not its character count", () => {
    const limit = 2_000;
    const buffer = createReplayMemoryBuffer({ ...REPLAY_RECORDING_LIMITS, maxBufferBytes: limit });
    const wide = (type: EventType) => ({ type, timestamp: 1, data: { pad: "é😀".repeat(100) } }) as unknown as eventWithTime;
    buffer.push(wide(EventType.Meta), 1);
    buffer.push(wide(EventType.FullSnapshot), 1);
    buffer.push(wide(EventType.Meta), 2);
    buffer.push(wide(EventType.FullSnapshot), 2);

    const serialized = JSON.stringify(buffer.events().map((entry) => entry.event));
    expect(serialized.length).toBeLessThan(limit);
    expect(new TextEncoder().encode(serialized).length).toBe(buffer.byteSize());
    expect(buffer.byteSize()).toBeLessThanOrEqual(limit);
    expect(buffer.events().map((entry) => [entry.boundary, entry.event.type])).toEqual([
      [2, EventType.Meta],
      [2, EventType.FullSnapshot],
    ]);
  });

  it("overflows a boundary whose single event fits in characters but not in bytes", () => {
    const buffer = createReplayMemoryBuffer({ ...REPLAY_RECORDING_LIMITS, maxBufferBytes: 1_000 });
    buffer.push({ type: EventType.Meta, timestamp: 1, data: { pad: "😀".repeat(300) } } as unknown as eventWithTime, 1);
    buffer.push(event(EventType.FullSnapshot), 1);

    expect(buffer.events()).toEqual([]);
    expect(buffer.isOverflowed(1)).toBe(true);
    buffer.push(event(EventType.Meta), 2);
    expect(buffer.events().map((entry) => entry.boundary)).toEqual([2]);
  });

  it("clears and notifies", () => {
    const buffer = createReplayMemoryBuffer(REPLAY_RECORDING_LIMITS);
    let heard = 0;
    buffer.subscribe(() => heard++);
    buffer.push(event(EventType.Meta), 1);
    const before = buffer.events();

    buffer.clear();

    expect(buffer.events()).toEqual([]);
    expect(buffer.events()).not.toBe(before);
    expect(heard).toBe(2);
  });
});
