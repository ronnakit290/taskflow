import { and, eq, isNull, lte, ne } from "drizzle-orm";
import {
  getDb,
  notifications,
  tasks,
  users,
  type Notification,
} from "../db";
import { getResendClient, getResendFromEmail } from "../lib/resend";

export interface DispatchSummary {
  checked: number;
  sent: number;
  skipped: number;
  failed: number;
  errors: Array<{ notificationId: string; message: string }>;
}

export interface NotificationDeps {
  db?: ReturnType<typeof getDb>;
  resend?: Pick<ReturnType<typeof getResendClient>, "emails">;
  from?: string;
  now?: Date;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Schedules a notification for a task unless the task is already `done`.
 * Uses (taskId, type) uniqueness to avoid duplicate queue entries.
 */
export async function scheduleTaskNotification(
  params: {
    taskId: string;
    userId: string;
    scheduledFor: Date;
    type?: Notification["type"];
  },
  deps?: Pick<NotificationDeps, "db">
): Promise<Notification | null> {
  const db = deps?.db ?? getDb();

  const [task] = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, params.taskId))
    .limit(1);

  if (!task || task.status === "done") {
    return null;
  }

  const [inserted] = await db
    .insert(notifications)
    .values({
      taskId: params.taskId,
      userId: params.userId,
      type: params.type ?? "reminder",
      scheduledFor: params.scheduledFor,
    })
    .onConflictDoNothing({
      target: [notifications.taskId, notifications.type],
    })
    .returning();

  return inserted ?? null;
}

/**
 * Dispatches all due, unsent notifications for tasks whose status is NOT `done`.
 * Atomically sets `sent_at` before calling Resend to prevent duplicate emails
 * across concurrent runs, and rolls back `sent_at` if sending fails.
 */
export async function dispatchDueNotifications(
  limit = 50,
  deps?: NotificationDeps
): Promise<DispatchSummary> {
  const db = deps?.db ?? getDb();
  const resend = deps?.resend ?? getResendClient();
  const from = deps?.from ?? getResendFromEmail();
  const now = deps?.now ?? new Date();

  const candidates = await db
    .select({
      notification: notifications,
      task: tasks,
      user: users,
    })
    .from(notifications)
    .innerJoin(tasks, eq(notifications.taskId, tasks.id))
    .innerJoin(users, eq(notifications.userId, users.id))
    .where(
      and(
        isNull(notifications.sentAt),
        lte(notifications.scheduledFor, now),
        ne(tasks.status, "done")
      )
    )
    .limit(limit);

  const summary: DispatchSummary = {
    checked: candidates.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  for (const row of candidates) {
    if (row.task.status === "done" || row.notification.sentAt !== null) {
      summary.skipped += 1;
      continue;
    }

    // Atomic claim: only succeeds if sent_at is still NULL
    const [claimed] = await db
      .update(notifications)
      .set({ sentAt: new Date() })
      .where(
        and(
          eq(notifications.id, row.notification.id),
          isNull(notifications.sentAt)
        )
      )
      .returning({ id: notifications.id });

    if (!claimed) {
      summary.skipped += 1;
      continue;
    }

    try {
      const dueText = row.task.dueAt
        ? `Due: ${row.task.dueAt.toISOString()}`
        : "No due date";

      const { data, error } = await resend.emails.send({
        from,
        to: row.user.email,
        subject: `[TaskFlow] Reminder: ${row.task.title}`,
        html: `
          <div style="font-family: sans-serif; line-height: 1.5;">
            <h2>Task Reminder</h2>
            <p>Hi ${escapeHtml(row.user.name)},</p>
            <p>Your task <strong>${escapeHtml(row.task.title)}</strong> is currently <code>${escapeHtml(row.task.status)}</code>.</p>
            <p>${escapeHtml(dueText)}</p>
            ${row.task.description ? `<p>${escapeHtml(row.task.description)}</p>` : ""}
          </div>
        `,
      });

      if (error) {
        throw new Error(error.message);
      }

      await db
        .update(notifications)
        .set({
          resendMessageId: data?.id ?? null,
          lastError: null,
        })
        .where(eq(notifications.id, row.notification.id));

      summary.sent += 1;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown Resend error";

      // Roll back sent_at so this notification can be retried
      await db
        .update(notifications)
        .set({
          sentAt: null,
          lastError: message,
        })
        .where(eq(notifications.id, row.notification.id));

      summary.failed += 1;
      summary.errors.push({
        notificationId: row.notification.id,
        message,
      });
    }
  }

  return summary;
}
