import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Notification, Task, User } from "../src/db/schema";
import {
  dispatchDueNotifications,
  scheduleTaskNotification,
  type NotificationDeps,
} from "../src/services/notifications";

interface MockStore {
  users: User[];
  tasks: Task[];
  notifications: Notification[];
}

function createMockDb(
  store: MockStore,
  options?: { simulateAlreadyClaimedOnUpdate?: boolean }
) {
  return {
    select() {
      return {
        from(table: unknown) {
          let joinCount = 0;
          const chain = {
            innerJoin() {
              joinCount += 1;
              return chain;
            },
            where() {
              return chain;
            },
            async limit() {
              // Single-table task lookup used by scheduleTaskNotification
              if (joinCount === 0) {
                return store.tasks.map((t) => ({ id: t.id, status: t.status }));
              }
              // Joined query used by dispatchDueNotifications
              return store.notifications.map((n) => ({
                notification: n,
                task: store.tasks.find((t) => t.id === n.taskId)!,
                user: store.users.find((u) => u.id === n.userId)!,
              }));
            },
          };
          void table;
          return chain;
        },
      };
    },
    insert() {
      return {
        values(val: Partial<Notification>) {
          return {
            onConflictDoNothing() {
              return {
                async returning() {
                  const created: Notification = {
                    id: `notif-${store.notifications.length + 1}`,
                    taskId: val.taskId!,
                    userId: val.userId!,
                    type: val.type ?? "reminder",
                    scheduledFor: val.scheduledFor!,
                    sentAt: null,
                    resendMessageId: null,
                    lastError: null,
                    createdAt: new Date(),
                  };
                  store.notifications.push(created);
                  return [created];
                },
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(patch: Partial<Notification>) {
          return {
            where() {
              const applyUpdate = () => {
                if (options?.simulateAlreadyClaimedOnUpdate) {
                  return [];
                }
                const target = store.notifications[0];
                if (!target) return [];
                // Enforce sent_at IS NULL guard when claiming
                if (patch.sentAt instanceof Date && target.sentAt !== null) {
                  return [];
                }
                Object.assign(target, patch);
                return [target];
              };

              const result = applyUpdate();
              // Support both awaited update(...) and update(...).returning()
              return Object.assign(Promise.resolve(result), {
                async returning() {
                  return result;
                },
              });
            },
          };
        },
      };
    },
  } as unknown as NonNullable<NotificationDeps["db"]>;
}

function createMockResend() {
  const sentEmails: Array<{ to: string; subject: string }> = [];
  const resend = {
    emails: {
      async send(payload: { to: string | string[]; subject: string }) {
        sentEmails.push({
          to: Array.isArray(payload.to) ? payload.to.join(",") : payload.to,
          subject: payload.subject,
        });
        return { data: { id: `re_${sentEmails.length}` }, error: null };
      },
    },
  } as unknown as NonNullable<NotificationDeps["resend"]>;

  return { resend, sentEmails };
}

describe("TaskFlow Notification Rules", () => {
  it("Rule 1: does not send duplicate notifications when sent_at is already set", async () => {
    const store: MockStore = {
      users: [
        {
          id: "user-1",
          email: "alice@example.com",
          name: "Alice",
          createdAt: new Date(),
        },
      ],
      tasks: [
        {
          id: "task-1",
          userId: "user-1",
          title: "Prepare Q4 report",
          description: null,
          status: "todo",
          dueAt: new Date("2026-11-18T10:00:00Z"),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      notifications: [
        {
          id: "notif-1",
          taskId: "task-1",
          userId: "user-1",
          type: "reminder",
          scheduledFor: new Date("2026-11-17T09:00:00Z"),
          sentAt: null,
          resendMessageId: null,
          lastError: null,
          createdAt: new Date(),
        },
      ],
    };

    const { resend, sentEmails } = createMockResend();
    const db = createMockDb(store);

    // First dispatch: should send 1 email and set sentAt
    const first = await dispatchDueNotifications(50, {
      db,
      resend,
      from: "TaskFlow <noreply@example.com>",
      now: new Date("2026-11-17T10:00:00Z"),
    });

    assert.equal(first.sent, 1);
    assert.equal(sentEmails.length, 1);
    assert.ok(store.notifications[0].sentAt instanceof Date);

    // Second dispatch: sent_at is already set, must skip and NOT send again
    const second = await dispatchDueNotifications(50, {
      db,
      resend,
      from: "TaskFlow <noreply@example.com>",
      now: new Date("2026-11-17T10:05:00Z"),
    });

    assert.equal(second.sent, 0);
    assert.equal(second.skipped, 1);
    assert.equal(sentEmails.length, 1);
  });

  it("Rule 2: never notifies when Task.status = done (both schedule and dispatch)", async () => {
    const store: MockStore = {
      users: [
        {
          id: "user-1",
          email: "bob@example.com",
          name: "Bob",
          createdAt: new Date(),
        },
      ],
      tasks: [
        {
          id: "task-done",
          userId: "user-1",
          title: "Completed task",
          description: null,
          status: "done",
          dueAt: new Date("2026-11-18T10:00:00Z"),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      notifications: [],
    };

    const db = createMockDb(store);
    const { resend, sentEmails } = createMockResend();

    // 2a. Scheduling a notification for a done task should return null
    const scheduled = await scheduleTaskNotification(
      {
        taskId: "task-done",
        userId: "user-1",
        scheduledFor: new Date("2026-11-17T09:00:00Z"),
      },
      { db }
    );
    assert.equal(scheduled, null);
    assert.equal(store.notifications.length, 0);

    // 2b. Even if a pending notification row exists for a done task, dispatch must skip it
    store.notifications.push({
      id: "notif-done",
      taskId: "task-done",
      userId: "user-1",
      type: "reminder",
      scheduledFor: new Date("2026-11-17T09:00:00Z"),
      sentAt: null,
      resendMessageId: null,
      lastError: null,
      createdAt: new Date(),
    });

    const summary = await dispatchDueNotifications(50, {
      db,
      resend,
      from: "TaskFlow <noreply@example.com>",
      now: new Date("2026-11-17T10:00:00Z"),
    });

    assert.equal(summary.sent, 0);
    assert.equal(summary.skipped, 1);
    assert.equal(sentEmails.length, 0);
    assert.equal(store.notifications[0].sentAt, null);
  });
});
