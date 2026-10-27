import type { NextRequest } from "next/server";

import { relayToEpic } from "@/lib/epic/relay";

/**
 * The app's one door to Epic: what the Epic runtime in its pages sends here
 * reaches Epic with this app's credential. See `lib/epic/relay.ts`.
 */
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ path: string[] }> };

async function handle(request: NextRequest, { params }: Params) {
  return relayToEpic(request, (await params).path, request.cookies);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
