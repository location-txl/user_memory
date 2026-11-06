import { useEffect, useState } from "react";
import { Check, Copy, RefreshCw, Upload, Terminal } from "lucide-react";
import type { Project } from "../contracts.js";
import type { Config } from "../config.js";
import { cliCommand } from "../cli-command.js";
import { api, date, statusNames } from "./api.js";

export type Status = {
  home: string;
  active: number;
  candidates: number;
  errors: string[];
  workerEnabled: boolean;
  receipts: { agent: string; captured_at?: string; recalled_at?: string }[];
  jobs: {
    id: number;
    agent: string;
    state: string;
    error?: string;
    updated_at: string;
  }[];
};
const hosts = [
  { id: "codex", name: "Codex", mode: "Hooks + MCP" },
  { id: "zcode", name: "ZCode", mode: "Hooks + MCP" },
  { id: "claude", name: "Claude Code", mode: "Hooks + MCP" },
  { id: "pi", name: "Pi", mode: "扩展 + MCP" },
  { id: "deepseek", name: "DeepSeek Harness", mode: "Cordis 插件 + MCP" },
  { id: "hermes", name: "Hermes", mode: "Memory provider + MCP" },
];
export function Operations({
  page,
  status,
  projects,
  onChange,
}: {
  page: string;
  status?: Status;
  projects: Project[];
  onChange(): void;
}) {
  if (page === "imports")
    return <ImportMemory projects={projects} onChange={onChange} />;
  if (page === "settings")
    return <Settings status={status} onChange={onChange} />;
  return (
    <div className="management">
      <header className="page-header">
        <div>
          <h1>工具接入</h1>
          <p>同一份记忆，带到每一个工作现场。</p>
        </div>
      </header>
      <div className="instruction">
        <Terminal size={22} />
        <div>
          <h2>安装前，先看变更</h2>
          <p>
            在任意目录运行下方命令预览；确认后加 <code>--apply</code>{" "}
            应用。安装会保留备份，原生记忆不会被自动关闭。
          </p>
        </div>
      </div>
      <div className="host-list">
        {hosts.map((h) => {
          const receipt = status?.receipts.find((r) => r.agent === h.id);
          return (
            <article className="host" key={h.id}>
              <div className="host-heading">
                <div className="host-monogram">{h.name[0]}</div>
                <div>
                  <h2>{h.name}</h2>
                  <span className="muted">{h.mode}</span>
                </div>
                <span
                  className={`connection ${receipt?.captured_at && receipt.recalled_at ? "connected" : ""}`}
                >
                  {receipt?.captured_at && receipt.recalled_at
                    ? "已收到双向记录"
                    : receipt
                      ? "待完成验证"
                      : "尚无接入记录"}
                </span>
              </div>
              <div className="host-evidence">
                <span>
                  最近采集 <b>{date(receipt?.captured_at)}</b>
                </span>
                <span>
                  最近召回 <b>{date(receipt?.recalled_at)}</b>
                </span>
              </div>
              <Command value={`${cliCommand(status?.home)} setup ${h.id}`} />
            </article>
          );
        })}
      </div>
      <section className="acceptance">
        <h2>一次跨工具验证</h2>
        <ol>
          <li>在工具 A 中说出一条带独特标记的长期偏好。</li>
          <li>到“设置与任务”查看提炼完成，在记忆库核对原文和来源。</li>
          <li>用工具 B 新建会话，询问该偏好，核对召回时间和模型回答。</li>
          <li>修改或撤回这条测试记忆，再验证旧版本不再使用。</li>
        </ol>
        <p className="muted">
          接入时间证明适配器调用成功；模型是否正确使用记忆，仍以新会话验证为准。
        </p>
      </section>
    </div>
  );
}
function Command({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="command">
      <code>{value}</code>
      <button
        aria-label="复制命令"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(
            () => setCopied(true),
            () => setError("复制失败，请手动选择命令"),
          );
        }}
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
type Preview = {
  path: string;
  hash: string;
  title: string;
  preview: string;
  size: number;
  index: boolean;
};
function ImportMemory({
  projects,
  onChange,
}: {
  projects: Project[];
  onChange(): void;
}) {
  const [path, setPath] = useState("");
  const [scope, setScope] = useState("global");
  const [files, setFiles] = useState<Preview[]>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function preview() {
    setBusy(true);
    setError("");
    setNotice("");
    setFiles(undefined);
    try {
      const result = await api<Preview[]>("/imports/preview", {
        method: "POST",
        body: { path },
      });
      setFiles(result);
      setSelected(new Set(result.filter((f) => !f.index).map((f) => f.path)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    setBusy(true);
    setError("");
    try {
      const result = await api<unknown[]>("/imports/confirm", {
        method: "POST",
        body: {
          files: files
            ?.filter((f) => selected.has(f.path))
            .map(({ path, hash }) => ({ path, hash })),
          scope: scope === "global" ? "global" : "project",
          projectId: scope === "global" ? undefined : scope,
        },
      });
      setNotice(`已导入 ${result.length} 条记录，请到待审核中确认。`);
      setFiles(undefined);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="management narrow">
      <header className="page-header">
        <div>
          <h1>导入记忆</h1>
          <p>把已有的 Markdown 记忆带过来，原文件保留。</p>
        </div>
      </header>
      <section className="form-section">
        <h2>选择本机文件或目录</h2>
        <p className="muted">
          只读取你指定的位置。先预览，再选择需要导入的文件；导入后均进入待审核。
        </p>
        <label className="field">
          绝对路径
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/你的用户名/.codex/memories_v2"
          />
        </label>
        <label className="field">
          导入到
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="global">全局记忆</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary"
          disabled={busy || !path.trim()}
          onClick={() => void preview()}
        >
          <Upload size={16} />
          预览文件
        </button>
      </section>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="success" role="status">
          {notice}
        </div>
      )}
      {files && (
        <section className="import-preview">
          <h2>预览 {files.length} 个文件</h2>
          <p className="muted">
            索引和汇总文件默认不选，避免和独立记忆重复导入。
          </p>
          {files.map((f) => (
            <article key={f.path}>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={selected.has(f.path)}
                  onChange={(e) =>
                    setSelected((s) => {
                      const next = new Set(s);
                      e.target.checked ? next.add(f.path) : next.delete(f.path);
                      return next;
                    })
                  }
                />
                <span>
                  {f.title}
                  {f.index ? "（索引 / 汇总）" : ""}
                </span>
              </label>
              <p className="file-path">{f.path}</p>
              <pre>{f.preview}</pre>
            </article>
          ))}
          <button
            className="primary"
            disabled={busy || !selected.size}
            onClick={() => void apply()}
          >
            将 {selected.size} 个文件导入待审核
          </button>
        </section>
      )}
    </div>
  );
}
function Settings({ status, onChange }: { status?: Status; onChange(): void }) {
  const [config, setConfig] = useState<Config>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<Config>("/config").then(setConfig, (e) => setError(e.message));
  }, []);
  return (
    <div className="management narrow">
      <header className="page-header">
        <div>
          <h1>设置与任务</h1>
          <p>记忆在本机保存，由已登录的 Codex CLI 提炼。</p>
        </div>
        <button onClick={onChange}>
          <RefreshCw size={16} />
          刷新
        </button>
      </header>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="success" role="status">
          {notice}
        </div>
      )}
      {config && (
        <form
          className="form-section"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            setNotice("");
            const { port, ...patch } = config;
            try {
              setConfig(
                await api<Config>("/config", { method: "PATCH", body: patch }),
              );
              setNotice("设置已保存");
              onChange();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>自动提炼</h2>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={config.extractionEnabled}
              onChange={(e) =>
                setConfig({ ...config, extractionEnabled: e.target.checked })
              }
            />
            自动整理新的会话证据
          </label>
          <p className="muted">
            暂停后继续保存待处理记录。提炼会调用你的 Codex
            登录账户，消耗相应额度。
          </p>
          <div className="form-columns">
            <label className="field">
              Codex 可执行文件
              <input
                required
                value={config.codexPath}
                onChange={(e) =>
                  setConfig({ ...config, codexPath: e.target.value })
                }
              />
            </label>
            <label className="field">
              模型（留空使用默认模型）
              <input
                value={config.model ?? ""}
                onChange={(e) =>
                  setConfig({ ...config, model: e.target.value || undefined })
                }
              />
            </label>
          </div>
          <label className="field">
            会话空闲多久后提炼（秒）
            <input
              type="number"
              min={0}
              required
              value={config.idleSeconds}
              onChange={(e) =>
                setConfig({ ...config, idleSeconds: Number(e.target.value) })
              }
            />
          </label>
          <button className="primary" disabled={busy}>
            保存设置
          </button>
        </form>
      )}
      <section className="form-section">
        <h2>数据位置</h2>
        <p className="file-path">{status?.home ?? "正在读取…"}</p>
        <p className="muted">
          记忆正文在 memories/*.md，修订在
          history/。撤回停止使用记忆，但不会物理删除历史和采集证据。
        </p>
        <Command
          value={`${cliCommand(status?.home)} export /绝对路径/记忆备份`}
        />
      </section>
      <section className="jobs">
        <h2>最近提炼任务</h2>
        {status?.jobs.length ? (
          status.jobs.map((j) => (
            <article key={j.id}>
              <div>
                <b>
                  #{j.id} {j.agent}
                </b>
                <span className={j.state === "failed" ? "failed" : "muted"}>
                  {statusNames[j.state]}
                </span>
                <time>{date(j.updated_at)}</time>
              </div>
              {j.error && <pre>{j.error}</pre>}
              {j.state === "failed" && (
                <button
                  onClick={() => {
                    void api(`/jobs/${j.id}/retry`, { method: "POST" }).then(
                      onChange,
                      (e) => setError(e.message),
                    );
                  }}
                >
                  重试任务
                </button>
              )}
            </article>
          ))
        ) : (
          <p className="muted">
            还没有提炼任务。接入工具并完成一次对话后，记录会出现在这里。
          </p>
        )}
      </section>
    </div>
  );
}
