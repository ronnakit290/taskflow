import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, tasks, type Task } from "@/db";
import { scheduleTaskNotification } from "@/services/notifications";

export async function GET() {
  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(tasks)
      .orderBy(desc(tasks.createdAt))
      .limit(50);

    return NextResponse.json({ tasks: rows });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch tasks";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      userId?: string;
      title?: string;
      description?: string;
      status?: Task["status"];
      dueAt?: string;
      notifyAt?: string;
    };

    if (!body.userId || !body.title) {
      return NextResponse.json(
        { error: "userId and title are required" },
        { status: 400 }
      );
    }

    const db = getDb();
    const [created] = await db
      .insert(tasks)
      .values({
        userId: body.userId,
        title: body.title,
        description: body.description ?? null,
        status: body.status ?? "todo",
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
      })
      .returning();

    let notification = null;
    if (body.notifyAt && created.status !== "done") {
      notification = await scheduleTaskNotification({
        taskId: created.id,
        userId: created.userId,
        scheduledFor: new Date(body.notifyAt),
      });
    }

    return NextResponse.json(
      { task: created, notification },
      { status: 201 }
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to create task";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as {
      id?: string;
      status?: Task["status"];
    };

    if (!body.id || !body.status) {
      return NextResponse.json(
        { error: "id and status are required" },
        { status: 400 }
      );
    }

    const db = getDb();
    const [updated] = await db
      .update(tasks)
      .set({
        status: body.status,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, body.id))
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    return NextResponse.json({ task: updated });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update task";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
