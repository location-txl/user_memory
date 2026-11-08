import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import {
  Search,
  Plus,
  FileText,
  Pencil,
  Check,
  Archive,
  X,
} from "lucide-react";
import type { Memory, Project } from "../contracts.js";
import { api } from "./api.js";
import type en from "./locales/en.js";
import { formatDate, formatError } from "./presentation.js";

const kindKeys = {
  preference: "preference",
  constraint: "constraint",
  decision: "decision",
  lesson: "lesson",
} as const satisfies Record<Memory["kind"], keyof typeof en>;
const statusKeys = {
  active: "active",
  candidate: "reviewQueue",
  withdrawn: "withdrawn",
} as const satisfies Record<Memory["status"], keyof typeof en>;
const roleKeys: Partial<Record<string, keyof typeof en>> = {
  user: "sourceRoleUser",
  assistant: "sourceRoleAssistant",
  system: "sourceRoleSystem",
  tool: "sourceRoleTool",
  developer: "sourceRoleDeveloper",
  manual: "sourceRoleManual",
  import: "sourceRoleImport",
};

type Props = {
  scope: string;
  candidates: boolean;
  projects: Project[];
  version: number;
  onChange(): void;
};
export function Library({
  scope,
  candidates,
  projects,
  version,
  onChange,
}: Props) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState(candidates ? "candidate" : "active");
  const [items, setItems] = useState<Memory[]>([]);
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const current = items.find((m) => m.id === selected);
  const project = projects.find((p) => p.id === scope);
  useEffect(() => {
    let live = true;
    setLoading(true);
    const timeout = setTimeout(
      () => {
        const body = {
          status: filter,
          query,
          ...(scope === "global"
            ? { scope: "global" }
            : scope === "all"
              ? { allProjects: true }
              : { scope: "project", projectId: scope }),
        };
        api<Memory[]>("/memories/search", { method: "POST", body })
          .then(
            (data) => {
              if (live) {
                setItems(data);
                setSelected((previous) =>
                  data.some((m) => m.id === previous) ? previous : data[0]?.id,
                );
                setError("");
              }
            },
            (e) => {
              if (live) setError(e);
            },
          )
          .finally(() => {
            if (live) setLoading(false);
          });
      },
      query ? 180 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timeout);
    };
  }, [scope, filter, query, version]);
  return (
    <>
      <header className="page-header">
        <div>
          <h1>
            {candidates
              ? t("reviewQueue")
              : (project?.name ?? t("globalMemories"))}
          </h1>
          <p>
            {candidates
              ? t("reviewQueueDescription")
              : project
                ? t("projectMemoriesDescription")
                : t("globalMemoriesDescription")}
          </p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>
          <Plus size={17} />
          {t("addMemory")}
        </button>
      </header>
      <div className="library-toolbar">
        <label className="search">
          <Search size={18} />
          <input
            aria-label={t("searchMemories")}
            placeholder={t("searchMemoriesPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {!candidates && (
          <select
            aria-label={t("memoryStatus")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="active">{t("activeFilter")}</option>
            <option value="withdrawn">{t("withdrawn")}</option>
          </select>
        )}
        <span className="muted">
          {t("memoryCount", { count: items.length })}
        </span>
      </div>
      {!!error && (
        <p className="alert" role="alert">
          {formatError(error, t)}
        </p>
      )}
      <div className="library-grid">
        <section className="memory-list" aria-label={t("memoryList")}>
          {loading ? (
            <p className="empty">{t("loadingMemories")}</p>
          ) : items.length ? (
            items.map((m) => (
              <button
                key={m.id}
                className={`memory-row ${selected === m.id ? "current" : ""}`}
                onClick={() => setSelected(m.id)}
              >
                <div className="row-meta">
                  <span className={`kind ${m.kind}`}>
                    {t(kindKeys[m.kind])}
                  </span>
                  <time>{formatDate(m.updatedAt, i18n)}</time>
                </div>
                <h2>{m.title}</h2>
                <p>{m.content}</p>
                <span className="row-source">
                  {[...new Set(m.sources.map((s) => s.agent))].join(" / ") ||
                    t("savedManually")}
                  {scope === "all" &&
                    ` · ${m.scope === "global" ? t("global") : (projects.find((p) => p.id === m.projectId)?.name ?? t("projects"))}`}
                </span>
              </button>
            ))
          ) : (
            <div className="empty">
              <FileText size={32} />
              <h2>
                {query
                  ? t("noMatchingMemories")
                  : candidates
                    ? t("emptyReviewQueue")
                    : t("emptyLibraryTitle")}
              </h2>
              <p>
                {query
                  ? t("shorterSearchHint")
                  : candidates
                    ? t("emptyReviewQueueDescription")
                    : t("emptyLibraryDescription")}
              </p>
              {!query && !candidates && (
                <button onClick={() => setCreating(true)}>
                  {t("addFirstMemory")}
                </button>
              )}
            </div>
          )}
        </section>
        <section className="detail-pane" aria-label={t("memoryDetails")}>
          {current ? (
            <MemoryDetail
              key={`${current.id}:${current.etag}`}
              memory={current}
              onChange={onChange}
            />
          ) : (
            <div className="detail-placeholder">
              <BookMark />
              <p>{t("memoryDetailsPlaceholder")}</p>
            </div>
          )}
        </section>
      </div>
      {creating && (
        <CreateMemory
          project={project}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            onChange();
          }}
        />
      )}
    </>
  );
}
function BookMark() {
  return <FileText size={42} strokeWidth={1} />;
}
function MemoryDetail({
  memory: m,
  onChange,
}: {
  memory: Memory;
  onChange(): void;
}) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(m.title);
  const [content, setContent] = useState(m.content);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Memory[]>();
  const [confirm, setConfirm] = useState(false);
  async function update(changes: object) {
    setBusy(true);
    setError("");
    try {
      await api(`/memories/${m.id}`, {
        method: "PATCH",
        body: { revision: m.revision, etag: m.etag, ...changes },
      });
      onChange();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="detail-label">
        <span>
          {t(statusKeys[m.status])} ·{" "}
          {t("revisionNumber", { revision: m.revision })}
        </span>
        <FileText size={17} />
      </div>
      {editing ? (
        <label className="field">
          {t("title")}
          <input
            value={title}
            maxLength={160}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
      ) : (
        <h2 className="detail-title">{m.title}</h2>
      )}
      {!!error && (
        <div className="alert" role="alert">
          {formatError(error, t)}
          <button onClick={onChange}>{t("reload")}</button>
        </div>
      )}
      {editing ? (
        <label className="field">
          {t("content")}
          <textarea
            rows={9}
            value={content}
            maxLength={16000}
            onChange={(e) => setContent(e.target.value)}
          />
        </label>
      ) : (
        <div className="memory-body">{m.content}</div>
      )}
      {m.reason && <p className="reason">{m.reason}</p>}
      {m.status !== "withdrawn" && (
        <div className="actions">
          {editing ? (
            <>
              <button
                className="primary"
                disabled={busy || !title.trim() || !content.trim()}
                onClick={() => void update({ title, content })}
              >
                <Check size={16} />
                {t("saveChanges")}
              </button>
              <button
                onClick={() => {
                  setEditing(false);
                  setTitle(m.title);
                  setContent(m.content);
                }}
              >
                {t("cancel")}
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setEditing(true)}>
                <Pencil size={15} />
                {t("edit")}
              </button>
              {m.status === "active" && (
                <button
                  disabled={busy}
                  aria-pressed={m.alwaysRecall === true}
                  onClick={() => void update({ alwaysRecall: !m.alwaysRecall })}
                >
                  {m.alwaysRecall
                    ? t("disableAlwaysRecall")
                    : t("enableAlwaysRecall")}
                </button>
              )}
              {m.status === "candidate" && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void update({ status: "active" })}
                >
                  <Check size={16} />
                  {t("approveMemory")}
                </button>
              )}
              <button className="quiet" onClick={() => setConfirm(true)}>
                <Archive size={15} />
                {m.status === "candidate" ? t("discard") : t("withdraw")}
              </button>
            </>
          )}
        </div>
      )}
      {confirm && (
        <div className="confirm">
          <p>{t("withdrawalExplanation")}</p>
          <button
            className="danger"
            disabled={busy}
            onClick={() => void update({ status: "withdrawn" })}
          >
            {t("confirmWithdrawal")}
          </button>
          <button onClick={() => setConfirm(false)}>{t("cancel")}</button>
        </div>
      )}
      <h3 className="section-title">{t("sources")}</h3>
      {m.sources.length ? (
        m.sources.map((s, i) => {
          const roleKey = roleKeys[s.role];
          return (
            <details className="source" key={`${s.id}:${i}`}>
              <summary>
                <span>
                  {s.agent}{" "}
                  <span className="muted">
                    / {roleKey ? t(roleKey) : s.role}
                  </span>
                </span>
                <time>{formatDate(s.at, i18n)}</time>
              </summary>
              <blockquote>{s.excerpt}</blockquote>
              {s.path && <p className="file-path">{s.path}</p>}
              <small>{t("sourceId", { id: s.id })}</small>
            </details>
          );
        })
      ) : (
        <p className="muted">{t("noSources")}</p>
      )}
      <details
        className="history"
        onToggle={(e) => {
          if (e.currentTarget.open && !history)
            void api<Memory[]>(`/memories/${m.id}/history`).then(
              setHistory,
              (e) => setError(e),
            );
        }}
      >
        <summary>{t("revisionHistory")}</summary>
        {history?.length ? (
          history.map((h) => (
            <article key={h.etag}>
              <b>{t("revisionNumber", { revision: h.revision })}</b>
              <time>{formatDate(h.updatedAt, i18n)}</time>
              <p>{h.content}</p>
            </article>
          ))
        ) : (
          <p className="muted">{t("noRevisions")}</p>
        )}
      </details>
      <footer className="detail-footer">
        <span>{t("createdAt", { date: formatDate(m.createdAt, i18n) })}</span>
        <details>
          <summary>{t("viewStorageLocation")}</summary>
          <p className="file-path">{m.file}</p>
          <small>{t("editMarkdownHint")}</small>
        </details>
      </footer>
    </>
  );
}
function CreateMemory({
  project,
  onClose,
  onSaved,
}: {
  project?: Project;
  onClose(): void;
  onSaved(): void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog ref={dialog} aria-labelledby="create-title" onCancel={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          setBusy(true);
          try {
            await api("/memories", {
              method: "POST",
              body: {
                title: form.get("title"),
                content: form.get("content"),
                kind: form.get("kind"),
                scope: project ? "project" : "global",
                projectId: project?.id,
              },
            });
            onSaved();
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-heading">
          <h2 id="create-title">{t("addMemory")}</h2>
          <button type="button" aria-label={t("close")} onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <p className="muted">
          {t("saveTo", { scope: project?.name ?? t("globalMemories") })}
        </p>
        {!!error && (
          <p className="alert" role="alert">
            {formatError(error, t)}
          </p>
        )}
        <label className="field">
          {t("title")}
          <input
            autoFocus
            name="title"
            required
            maxLength={160}
            placeholder={t("memoryTitlePlaceholder")}
          />
        </label>
        <label className="field">
          {t("content")}
          <textarea
            name="content"
            required
            maxLength={16000}
            rows={6}
            placeholder={t("memoryContentPlaceholder")}
          />
        </label>
        <label className="field">
          {t("memoryKind")}
          <select name="kind">
            {Object.entries(kindKeys).map(([v, key]) => (
              <option value={v} key={v}>
                {t(key)}
              </option>
            ))}
          </select>
        </label>
        <div className="actions">
          <button className="primary" disabled={busy}>
            {t("saveMemory")}
          </button>
          <button type="button" onClick={onClose}>
            {t("cancel")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
