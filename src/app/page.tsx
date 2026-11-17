export default function HomePage() {
  return (
    <main style={{ maxWidth: 640, margin: "0 auto" }}>
      <h1>TaskFlow</h1>
      <p>Next.js (App Router) + TypeScript + Neon Postgres (Drizzle) + Resend</p>
      <ul>
        <li>
          <code>GET / POST / PATCH /api/tasks</code> — Manage tasks &amp; schedule notifications
        </li>
        <li>
          <code>GET / POST /api/notifications/dispatch</code> — Dispatch due notifications
        </li>
      </ul>
    </main>
  );
}
