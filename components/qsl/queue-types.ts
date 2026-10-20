// The email queue as GET /api/qsl/queue returns it. Client-side copy of the shape; the
// API module imports Prisma and cannot be pulled into a page bundle.

export type QslQueueStatus = "PENDING" | "APPROVED" | "SENT" | "FAILED" | "SKIPPED";

export interface QslQueueEntry {
  id: string;
  qsoId: string;
  callsign: string;
  toAddress: string;
  subject: string;
  bodyText: string;
  status: QslQueueStatus;
  error: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  createdAt: string;
  qso: { band: string; mode: string; startTime: string; gridSquare: string | null } | null;
  approvedBy: { name: string } | null;
}

export const QUEUE_STATUS: Record<
  QslQueueStatus,
  { label: string; tone: "warn" | "info" | "ok" | "danger" | "neutral" }
> = {
  // Amber is "waiting on a person" across the app.
  PENDING: { label: "Awaiting review", tone: "warn" },
  APPROVED: { label: "Approved", tone: "info" },
  SENT: { label: "Sent", tone: "ok" },
  FAILED: { label: "Failed", tone: "danger" },
  SKIPPED: { label: "Skipped", tone: "neutral" },
};
