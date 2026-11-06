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
import { api, date, kindNames, statusNames } from "./api.js";

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
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState(candidates ? "candidate" : "active");
  const [items, setItems] = useState<Memory[]>([]);
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const current = items.find((m) => m.id === selected);
  const project = projects.find((p) => p.id === scope);
  useEffect(() => {
    let live = true;
    setLoading(true);
    const timeout = setTimeout(
      () => {
        const params = new URLSearchParams({
          status: filter,
          q: query,
          ...(scope === "global"
            ? { scope: "global" }
            : scope === "all"
              ? { all: "true" }
              : { scope: "project", projectId: scope }),
        });
        api<Memory[]>(`/memories?${params}`)
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
              if (live) setError(e.message);
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
          <h1>{candidates ? "待审核" : (project?.name ?? "全局记忆")}</h1>
          <p>
            {candidates
              ? "证据尚不充分，确认后才会出现在召回中。"
              : project
                ? "仅在这个项目及其关联目录中使用。"
                : "跨项目共享的偏好与约定，所有接入工具都能读取。"}
          </p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>
          <Plus size={17} />
          记一条
        </button>
      </header>
      <div className="library-toolbar">
        <label className="search">
          <Search size={18} />
          <input
            aria-label="搜索记忆"
            placeholder="搜索内容、标题…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {!candidates && (
          <select
            aria-label="记忆状态"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="active">生效中</option>
            <option value="withdrawn">已撤回</option>
          </select>
        )}
        <span className="muted">{items.length} 条记忆</span>
      </div>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="library-grid">
        <section className="memory-list" aria-label="记忆列表">
          {loading ? (
            <p className="empty">正在读取记忆…</p>
          ) : items.length ? (
            items.map((m) => (
              <button
                key={m.id}
                className={`memory-row ${selected === m.id ? "current" : ""}`}
                onClick={() => setSelected(m.id)}
              >
                <div className="row-meta">
                  <span className={`kind ${m.kind}`}>{kindNames[m.kind]}</span>
                  <time>{date(m.updatedAt)}</time>
                </div>
                <h2>{m.title}</h2>
                <p>{m.content}</p>
                <span className="row-source">
                  {[...new Set(m.sources.map((s) => s.agent))].join(" / ") ||
                    "手动保存"}
                  {scope === "all" &&
                    ` · ${m.scope === "global" ? "全局" : (projects.find((p) => p.id === m.projectId)?.name ?? "项目")}`}
                </span>
              </button>
            ))
          ) : (
            <div className="empty">
              <FileText size={32} />
              <h2>
                {query
                  ? "没有匹配的记忆"
                  : candidates
                    ? "没有待审核记录"
                    : "给下一次对话留一点线索"}
              </h2>
              <p>
                {query
                  ? "试试更短的关键词。"
                  : candidates
                    ? "自动提炼中不确定的内容会出现在这里。"
                    : "可以手动记下一条长期偏好，或接入常用工具。"}
              </p>
              {!query && !candidates && (
                <button onClick={() => setCreating(true)}>
                  添加第一条记忆
                </button>
              )}
            </div>
          )}
        </section>
        <section className="detail-pane" aria-label="记忆详情">
          {current ? (
            <MemoryDetail
              key={`${current.id}:${current.etag}`}
              memory={current}
              onChange={onChange}
            />
          ) : (
            <div className="detail-placeholder">
              <BookMark />
              <p>
                记忆的原文、来源和修订
                <br />
                会显示在这里。
              </p>
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
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(m.title);
  const [content, setContent] = useState(m.content);
  const [error, setError] = useState("");
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
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="detail-label">
        <span>
          {statusNames[m.status]} · 第 {m.revision} 版
        </span>
        <FileText size={17} />
      </div>
      {editing ? (
        <label className="field">
          标题
          <input
            value={title}
            maxLength={160}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
      ) : (
        <h2 className="detail-title">{m.title}</h2>
      )}
      {error && (
        <div className="alert" role="alert">
          {error}
          <button onClick={onChange}>重新读取</button>
        </div>
      )}
      {editing ? (
        <label className="field">
          内容
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
                保存修改
              </button>
              <button
                onClick={() => {
                  setEditing(false);
                  setTitle(m.title);
                  setContent(m.content);
                }}
              >
                取消
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setEditing(true)}>
                <Pencil size={15} />
                编辑
              </button>
              {m.status === "candidate" && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void update({ status: "active" })}
                >
                  <Check size={16} />
                  确认记住
                </button>
              )}
              <button className="quiet" onClick={() => setConfirm(true)}>
                <Archive size={15} />
                {m.status === "candidate" ? "不保留" : "撤回"}
              </button>
            </>
          )}
        </div>
      )}
      {confirm && (
        <div className="confirm">
          <p>
            撤回后不再注入新对话，下一次召回会提示现有会话忽略旧内容。修订历史仍保留。
          </p>
          <button
            className="danger"
            disabled={busy}
            onClick={() => void update({ status: "withdrawn" })}
          >
            确认撤回
          </button>
          <button onClick={() => setConfirm(false)}>取消</button>
        </div>
      )}
      <h3 className="section-title">从哪里记住</h3>
      {m.sources.length ? (
        m.sources.map((s, i) => (
          <details className="source" key={`${s.id}:${i}`}>
            <summary>
              <span>
                {s.agent} <span className="muted">/ {s.role}</span>
              </span>
              <time>{date(s.at)}</time>
            </summary>
            <blockquote>{s.excerpt}</blockquote>
            {s.path && <p className="file-path">{s.path}</p>}
            <small>来源 ID：{s.id}</small>
          </details>
        ))
      ) : (
        <p className="muted">没有来源记录</p>
      )}
      <details
        className="history"
        onToggle={(e) => {
          if (e.currentTarget.open && !history)
            void api<Memory[]>(`/memories/${m.id}/history`).then(
              setHistory,
              (e) => setError(e.message),
            );
        }}
      >
        <summary>修订历史</summary>
        {history?.length ? (
          history.map((h) => (
            <article key={h.etag}>
              <b>第 {h.revision} 版</b>
              <time>{date(h.updatedAt)}</time>
              <p>{h.content}</p>
            </article>
          ))
        ) : (
          <p className="muted">尚无历史修订</p>
        )}
      </details>
      <footer className="detail-footer">
        <span>创建于 {date(m.createdAt)}</span>
        <details>
          <summary>查看存储位置</summary>
          <p className="file-path">{m.file}</p>
          <small>可直接编辑 Markdown；重新读取时自动更新索引。</small>
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
  const [error, setError] = useState("");
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
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-heading">
          <h2 id="create-title">记一条</h2>
          <button type="button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <p className="muted">保存到 {project?.name ?? "全局记忆"}</p>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <label className="field">
          标题
          <input
            autoFocus
            name="title"
            required
            maxLength={160}
            placeholder="例如：默认使用中文沟通"
          />
        </label>
        <label className="field">
          内容
          <textarea
            name="content"
            required
            maxLength={16000}
            rows={6}
            placeholder="写下希望所有工具持续记住的内容…"
          />
        </label>
        <label className="field">
          类型
          <select name="kind">
            {Object.entries(kindNames).map(([v, label]) => (
              <option value={v} key={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="actions">
          <button className="primary" disabled={busy}>
            保存记忆
          </button>
          <button type="button" onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </dialog>
  );
}
