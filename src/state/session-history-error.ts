/** A durable history mutation has no final, verified outcome yet. */
export class SessionHistoryPendingError extends Error {
  constructor() { super("history_outcome_pending"); this.name = "SessionHistoryPendingError"; }
}
