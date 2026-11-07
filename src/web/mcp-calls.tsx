import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { agents, mcpOutcomes, mcpTools } from "../contract-values.js";
import type { McpCallsPage } from "../mcp-calls.js";
import { api } from "./api.js";
import { formatError } from "./presentation.js";

export function McpCalls({
  version,
  onRefresh,
}: {
  version: number;
  onRefresh(): void;
}) {
  const { t } = useTranslation();
  const [days, setDays] = useState("7");
  const [tool, setTool] = useState("");
  const [agent, setAgent] = useState("");
  const [outcome, setOutcome] = useState("");
  const query = new URLSearchParams({ days });
  if (tool) query.set("tool", tool);
  if (agent) query.set("agent", agent);
  if (outcome) query.set("outcome", outcome);

  return (
    <div className="management mcp-calls">
      <header className="page-header">
        <div>
          <h1>{t("mcpCalls")}</h1>
          <p>{t("mcpCallsDescription")}</p>
        </div>
        <button onClick={onRefresh}>
          <RefreshCw size={15} /> {t("refresh")}
        </button>
      </header>
      <div className="mcp-filters form-section">
        <label className="field">
          {t("mcpPeriod")}
          <select value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="7">{t("mcpLastDays", { days: 7 })}</option>
            <option value="30">{t("mcpLastDays", { days: 30 })}</option>
          </select>
        </label>
        <label className="field">
          {t("mcpTool")}
          <select value={tool} onChange={(e) => setTool(e.target.value)}>
            <option value="">{t("mcpAllTools")}</option>
            {mcpTools.map((name) => (
              <option key={name} value={name}>
                {name === "unknown" ? t("mcpUnknownTool") : name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t("mcpAgent")}
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">{t("mcpAllAgents")}</option>
            {agents.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t("mcpDetailOutcome")}
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">{t("mcpAllOutcomes")}</option>
            {mcpOutcomes.map((value) => (
              <option key={value} value={value}>
                {t(`mcp_${value}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <McpCallResults key={`${query}:${version}`} query={query.toString()} />
    </div>
  );
}

function McpCallResults({ query }: { query: string }) {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<McpCallsPage>();
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    let active = true;
    void api<McpCallsPage>(`/mcp-calls?${query}`).then(
      (result) => {
        if (active) setData(result);
      },
      (reason) => {
        if (active) setError(reason);
      },
    );
    return () => {
      active = false;
    };
  }, [query]);

  async function loadMore(cursor: string) {
    setLoadingMore(true);
    setError(null);
    try {
      const next = await api<McpCallsPage>(
        `/mcp-calls?${query}&before=${encodeURIComponent(cursor)}`,
      );
      setData(
        (previous) =>
          previous && {
            ...next,
            calls: [...previous.calls, ...next.calls],
          },
      );
    } catch (reason) {
      setError(reason);
    } finally {
      setLoadingMore(false);
    }
  }

  const number = new Intl.NumberFormat(i18n.language);
  const percent = new Intl.NumberFormat(i18n.language, {
    style: "percent",
    maximumFractionDigits: 1,
  });
  const date = new Intl.DateTimeFormat(i18n.language, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const unavailable = "–";
  const nextCursor = data?.nextCursor;
  const search = data?.summary.find(({ tool }) => tool === "memory_search");
  const columns = [
    t("mcpCallCount"),
    t("mcpFailureRate"),
    t("mcpRejectedCount"),
    t("mcpCancelledCount"),
    t("mcpP95"),
  ];
  return (
    <>
      {!data &&
        (error ? (
          <div className="alert" role="alert">
            {formatError(error, t)}
          </div>
        ) : (
          <p className="form-section muted" role="status">
            {t("loading")}
          </p>
        ))}
      {data && (
        <>
          <section
            className="form-section mcp-summary"
            aria-labelledby="mcp-summary"
          >
            <h2 id="mcp-summary">{t("mcpSummary")}</h2>
            <p className="muted">{t("mcpSummaryHint")}</p>
            <table
              className="mcp-table"
              role="table"
              aria-labelledby="mcp-summary"
            >
              <thead role="rowgroup">
                <tr role="row">
                  <th scope="col" role="columnheader">
                    {t("mcpTool")}
                  </th>
                  {columns.map((label) => (
                    <th key={label} scope="col" role="columnheader">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody role="rowgroup">
                {data.summary.map((row) => {
                  const completed = row.calls - row.cancelled;
                  const cells = [
                    number.format(row.calls),
                    completed
                      ? percent.format(row.failures / completed)
                      : unavailable,
                    number.format(row.rejected),
                    number.format(row.cancelled),
                    row.p95Ms === null
                      ? unavailable
                      : t("mcpMilliseconds", {
                          value: number.format(row.p95Ms),
                        }),
                  ];
                  return (
                    <tr key={row.tool} role="row">
                      <th scope="row" role="rowheader">
                        {row.tool === "unknown" ? (
                          t("mcpUnknownTool")
                        ) : (
                          <code>{row.tool}</code>
                        )}
                      </th>
                      {cells.map((value, index) => (
                        <td key={columns[index]} role="cell">
                          <span className="mcp-mobile-label" aria-hidden="true">
                            {columns[index]}
                          </span>
                          <span>{value}</span>
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {search && (
              <dl className="mcp-search-stats">
                <div>
                  <dt>{t("mcpEmptySearches")}</dt>
                  <dd>{number.format(search.emptySearches)}</dd>
                </div>
                <div>
                  <dt>{t("mcpLimitedSearches")}</dt>
                  <dd>{number.format(search.limitedSearches)}</dd>
                </div>
                <div>
                  <dt>{t("mcpAverageSearchBytes")}</dt>
                  <dd>
                    {search.averageResponseBytes === null
                      ? unavailable
                      : t("mcpBytes", {
                          value: number.format(search.averageResponseBytes),
                        })}
                  </dd>
                </div>
              </dl>
            )}
          </section>
          <section
            className="form-section mcp-records"
            aria-labelledby="mcp-records"
          >
            <h2 id="mcp-records">{t("mcpRecords")}</h2>
            {data.calls.length ? (
              <ol className="mcp-record-list">
                {data.calls.map((call) => (
                  <li key={call.id}>
                    <div className="mcp-record-main">
                      <strong>
                        {call.tool === "unknown" ? (
                          t("mcpUnknownTool")
                        ) : (
                          <code>{call.tool}</code>
                        )}
                      </strong>
                      <span className="muted">{call.agent}</span>
                      <time dateTime={new Date(call.at).toISOString()}>
                        {date.format(call.at)}
                      </time>
                      <span
                        className="mcp-record-outcome"
                        data-outcome={call.outcome}
                      >
                        {t(`mcp_${call.outcome}`)}
                      </span>
                      <span className="mcp-record-duration">
                        {t("mcpMilliseconds", {
                          value: number.format(call.durationMs),
                        })}
                      </span>
                    </div>
                    <div className="mcp-record-meta muted">
                      {call.errorCode && (
                        <span>{t(`error_${call.errorCode}`)}</span>
                      )}
                      {call.responseBytes !== null && (
                        <span>
                          {t("mcpBytes", {
                            value: number.format(call.responseBytes),
                          })}
                        </span>
                      )}
                      {call.searchTotal !== null &&
                        call.searchReturned !== null && (
                          <span>
                            {t("mcpSearchResultCounts", {
                              total: number.format(call.searchTotal),
                              returned: number.format(call.searchReturned),
                            })}
                          </span>
                        )}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">{t("mcpNoCalls")}</p>
            )}
            {!!error && <p role="alert">{formatError(error, t)}</p>}
            {nextCursor && (
              <button
                disabled={loadingMore}
                onClick={() => void loadMore(nextCursor)}
              >
                {loadingMore ? t("loading") : t("mcpLoadMore")}
              </button>
            )}
          </section>
        </>
      )}
    </>
  );
}
