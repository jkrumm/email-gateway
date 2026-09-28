import { Fragment } from "react";
import type {
  SubmissionRecord,
  SubmissionSource,
  Verdict,
} from "../../db/mail-submissions";
import { AdminLayout } from "../layout";
import { Badge, EmptyState } from "../ui";
import { formatLatency, formatListDateTime, formatPercent } from "../format";

const VERDICT_COLOR: Record<Verdict, string> = {
  legit: "good",
  marketing: "warn",
  spam: "bad",
};

function JevCell({ submission }: { submission: SubmissionRecord }) {
  const { jev } = submission;
  if (!jev || jev.verdict === null || jev.confidence === null) {
    return (
      <span className="page-subtitle">
        {jev?.error ? `error: ${jev.error}` : "not yet judged"}
      </span>
    );
  }

  const agrees = jev.verdict === submission.verdict;
  return (
    <>
      <Badge color={VERDICT_COLOR[jev.verdict]}>{jev.verdict}</Badge>{" "}
      <span className="mono">{formatPercent(jev.confidence)}</span>{" "}
      <Badge color={agrees ? "good" : "warn"}>
        {agrees ? "agrees" : "differs"}
      </Badge>
      <p className="summary-line mono">
        LLM {formatLatency(submission.llmLatencyMs)} · Jev{" "}
        {formatLatency(jev.latencyMs)}
      </p>
    </>
  );
}

export interface SubmissionsFilters {
  verdict?: Verdict;
  source?: SubmissionSource;
  delivered?: boolean;
}

export function SubmissionsPage({
  filters,
  submissions,
  nextCursor,
  hasCursor,
  now,
  notice,
}: {
  filters: SubmissionsFilters;
  submissions: SubmissionRecord[];
  nextCursor: string | null;
  hasCursor: boolean;
  now: Date;
  notice?: { text: string; error?: boolean } | null;
}) {
  const persistedFields: [string, string | undefined][] = [
    ["verdict", filters.verdict],
    ["source", filters.source],
    [
      "delivered",
      filters.delivered === undefined ? undefined : String(filters.delivered),
    ],
  ];
  const persistedQuery = persistedFields
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${encodeURIComponent(value!)}`)
    .join("&");

  return (
    <AdminLayout title="Spam filter" active="submissions" notice={notice}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Spam filter</h1>
          <p className="page-subtitle">
            Every contact-form submission judged, persisted history.
          </p>
        </div>
        <div className="page-actions">
          <form method="post" action="/admin/sync">
            <button type="submit" className="btn btn-primary">
              Sync now
            </button>
          </form>
        </div>
      </div>

      <form className="filter-bar" method="get" action="/admin/submissions">
        <div className="field">
          <label htmlFor="verdict">Verdict</label>
          <select
            className="control"
            id="verdict"
            name="verdict"
            defaultValue={filters.verdict ?? ""}
          >
            <option value="">All verdicts</option>
            <option value="legit">legit</option>
            <option value="marketing">marketing</option>
            <option value="spam">spam</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="source">Source</label>
          <select
            className="control"
            id="source"
            name="source"
            defaultValue={filters.source ?? ""}
          >
            <option value="">All sources</option>
            <option value="fpp">fpp</option>
            <option value="sy-serendipity">sy-serendipity</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="delivered">Delivery</label>
          <select
            className="control"
            id="delivered"
            name="delivered"
            defaultValue={
              filters.delivered === undefined ? "" : String(filters.delivered)
            }
          >
            <option value="">All</option>
            <option value="true">Delivered</option>
            <option value="false">Suppressed</option>
          </select>
        </div>
        <div className="field">
          <button type="submit" className="btn btn-primary">
            Apply
          </button>
        </div>
        <div className="field">
          <a className="btn" href="/admin/submissions">
            Reset
          </a>
        </div>
      </form>

      {submissions.length === 0 ? (
        <EmptyState
          title="No submissions judged yet"
          body="Contact-form submissions show up here once received."
        />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Source</th>
                  <th>Verdict</th>
                  <th>Jev</th>
                  <th>Delivery</th>
                  <th>Reason</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {submissions.map((submission) => (
                  <tr key={submission.id}>
                    <td>{formatListDateTime(submission.receivedAt, now)}</td>
                    <td>{submission.source}</td>
                    <td>
                      <Badge color={VERDICT_COLOR[submission.verdict]}>
                        {submission.verdict}
                      </Badge>
                      <span className="mono">
                        {formatPercent(submission.confidence)}
                      </span>
                      <span className="meter">
                        <span
                          className="meter-fill"
                          style={{
                            width: `${Math.round(submission.confidence * 100)}%`,
                          }}
                        />
                      </span>
                    </td>
                    <td>
                      <JevCell submission={submission} />
                    </td>
                    <td>
                      <Badge color={submission.delivered ? "good" : "outline"}>
                        {submission.delivered ? "delivered" : "suppressed"}
                      </Badge>
                    </td>
                    <td>{submission.reason}</td>
                    <td>
                      <details>
                        <summary>View</summary>
                        <dl className="fact-grid">
                          {Object.entries(submission.submission).map(
                            ([key, value]) => (
                              <Fragment key={key}>
                                <dt>{key}</dt>
                                <dd>{value === null ? "—" : String(value)}</dd>
                              </Fragment>
                            ),
                          )}
                        </dl>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <span>
              {hasCursor ? (
                <a
                  href={
                    persistedQuery
                      ? `/admin/submissions?${persistedQuery}`
                      : "/admin/submissions"
                  }
                >
                  ← Newest
                </a>
              ) : null}
            </span>
            <span>
              {nextCursor ? (
                <a
                  href={`/admin/submissions?${persistedQuery ? `${persistedQuery}&` : ""}cursor=${encodeURIComponent(nextCursor)}`}
                >
                  Older →
                </a>
              ) : null}
            </span>
          </div>
        </>
      )}
    </AdminLayout>
  );
}
