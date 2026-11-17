import { NextResponse } from "next/server";
import { getOptionalEnv } from "@/lib/env";
import { dispatchDueNotifications } from "@/services/notifications";

function isAuthorized(request: Request): boolean {
  const cronSecret = getOptionalEnv("CRON_SECRET");
  if (!cronSecret) {
    return true;
  }
  const authHeader = request.headers.get("authorization");
  return authHeader === `Bearer ${cronSecret}`;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await dispatchDueNotifications();
    return NextResponse.json({ ok: true, summary });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to dispatch notifications";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
