import { describe, expect, it, vi } from "vitest";
import { createReplayIdentity, subscribeReplayIdentityBoundary, withReplayIdentityBoundary } from "../replay-identity";

const ack = () => Response.json({ contractVersion: 1 });

describe("replay identity before capture", () => {
  it("acknowledges reset before bootstrap without resetting an ordinary reload", async () => {
    const methods: string[] = [];
    const identity = createReplayIdentity({ fetch: vi.fn(async (_url, init) => {
      methods.push(init!.method!); return ack();
    }) });
    const signal = new AbortController().signal;
    expect(await identity.acknowledge({ signal, reset: true })).toBe(true);
    expect(await identity.acknowledge({ signal })).toBe(true);
    expect(methods).toEqual(["DELETE", "POST", "POST"]);
  });

  it("serializes cancelled reset and reconciles uncertainty before the next bootstrap", async () => {
    let resolve!: (response: Response) => void;
    const methods: string[] = [];
    const identity = createReplayIdentity({ fetch: vi.fn(async (_url, init) => {
      methods.push(init!.method!);
      return methods.length === 1 ? new Promise<Response>((done) => { resolve = done; }) : ack();
    }) });
    const first = new AbortController();
    const pending = identity.acknowledge({ signal: first.signal, reset: true });
    await Promise.resolve();
    first.abort();
    const second = identity.acknowledge({ signal: new AbortController().signal });
    expect(methods).toEqual(["DELETE"]);
    resolve(ack());
    expect(await pending).toBe(false);
    expect(await second).toBe(true);
    expect(methods).toEqual(["DELETE", "DELETE", "POST"]);
  });

  it("fails closed on malformed/cookie rejection and bounds transient attempts", async () => {
    const rejected = vi.fn(async () => Response.json({ contractVersion: 1 }, { status: 401 }));
    expect(await createReplayIdentity({ fetch: rejected }).acknowledge({ signal: new AbortController().signal })).toBe(false);
    expect(rejected).toHaveBeenCalledTimes(1);
    const failed = vi.fn(async () => { throw new Error("offline"); });
    expect(await createReplayIdentity({ fetch: failed }).acknowledge({ signal: new AbortController().signal })).toBe(false);
    expect(failed).toHaveBeenCalledTimes(3);
  });

  it("does not let an older reset acknowledgment erase a newer identity boundary", async () => {
    let resolveJson!: (value: unknown) => void;
    const methods: string[] = [];
    const identity = createReplayIdentity({ fetch: vi.fn(async (_url, init) => {
      methods.push(init!.method!);
      if (methods.length === 1) return { ok: true, json: () => new Promise((resolve) => { resolveJson = resolve; }) } as Response;
      return ack();
    }) });
    const pending = identity.acknowledge({ signal: new AbortController().signal, reset: true });
    await Promise.resolve(); await Promise.resolve();
    identity.requireReset();
    resolveJson({ contractVersion: 1 });
    expect(await pending).toBe(true);
    expect(methods).toEqual(["DELETE", "DELETE", "POST"]);
  });

  it("cancellation during reset JSON keeps the reset debt for the next bootstrap", async () => {
    let resolveJson!: (value: unknown) => void;
    const methods: string[] = [];
    const identity = createReplayIdentity({ fetch: vi.fn(async (_url, init) => {
      methods.push(init!.method!);
      return methods.length === 1 ? { ok: true, json: () => new Promise((resolve) => { resolveJson = resolve; }) } as Response : ack();
    }) });
    const controller = new AbortController();
    const pending = identity.acknowledge({ signal: controller.signal, reset: true });
    await Promise.resolve(); await Promise.resolve(); controller.abort(); resolveJson({ contractVersion: 1 });
    expect(await pending).toBe(false);
    expect(await identity.acknowledge({ signal: new AbortController().signal })).toBe(true);
    expect(methods).toEqual(["DELETE", "DELETE", "POST"]);
  });

  it("stops synchronously before authentication and preserves the authentication result", async () => {
    const order: string[] = [];
    const unsubscribe = subscribeReplayIdentityBoundary(({ phase }) => { order.push(phase); });
    expect(await withReplayIdentityBoundary(async () => { order.push("auth"); return "signed-in"; })).toBe("signed-in");
    unsubscribe();
    expect(order).toEqual(["begin", "auth", "settled"]);
  });
});
