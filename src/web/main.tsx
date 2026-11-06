import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BookOpen,
  Globe2,
  Folder,
  Inbox,
  Cable,
  ArrowDownToLine,
  SlidersHorizontal,
  RefreshCw,
} from "lucide-react";
import type { Project } from "../contracts.js";
import { api } from "./api.js";
import { Library } from "./memory-library.js";
import { Operations, type Status } from "./operations.js";
import "./style.css";

const token = new URLSearchParams(location.hash.slice(1)).get("token");
if (token) {
  sessionStorage.setItem("umem-token", token);
  history.replaceState(null, "", location.pathname);
}
function App() {
  const [page, setPage] = useState("memories");
  const [scope, setScope] = useState("global");
  const [projects, setProjects] = useState<Project[]>([]);
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);
  useEffect(() => {
    let live = true;
    const load = () =>
      Promise.all([api<Project[]>("/projects"), api<Status>("/status")]).then(
        ([p, s]) => {
          if (live) {
            setProjects(p);
            setStatus(s);
            setError("");
          }
        },
        (e) => {
          if (live) setError(String(e.message));
        },
      );
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [version]);
  const navigate = (next: string, nextScope = scope) => {
    setPage(next);
    setScope(nextScope);
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("memories", "global");
          }}
        >
          <BookOpen size={25} />
          <span>
            公共记忆<small>在不同工具间，接着思考。</small>
          </span>
        </a>
        <nav aria-label="记忆范围">
          <button
            className={
              page === "memories" && scope === "global" ? "selected" : ""
            }
            onClick={() => navigate("memories", "global")}
          >
            <Globe2 size={18} />
            全局记忆
          </button>
          <button
            className={page === "candidates" ? "selected" : ""}
            onClick={() => navigate("candidates", "all")}
          >
            <Inbox size={18} />
            待审核<span className="count">{status?.candidates ?? 0}</span>
          </button>
          <div className="nav-label">项目</div>
          {projects.map((p) => (
            <button
              key={p.id}
              className={
                page === "memories" && scope === p.id ? "selected" : ""
              }
              onClick={() => navigate("memories", p.id)}
            >
              <Folder size={17} />
              <span className="truncate">{p.name}</span>
            </button>
          ))}
          {!projects.length && (
            <p className="nav-empty">
              工具在项目中使用记忆时，
              <br />
              会自动登记项目。
            </p>
          )}
          <div className="nav-label">管理</div>
          {[
            { id: "connections", label: "工具接入", Icon: Cable },
            { id: "imports", label: "导入记忆", Icon: ArrowDownToLine },
            { id: "settings", label: "设置与任务", Icon: SlidersHorizontal },
          ].map(({ id, label, Icon }) => (
            <button
              key={id}
              className={page === id ? "selected" : ""}
              onClick={() => navigate(id)}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
        <div className="service-state">
          <span className={`dot ${error ? "offline" : ""}`} />
          {error ? "连接中断" : "本机服务"}
          <button aria-label="刷新" onClick={refresh}>
            <RefreshCw size={15} />
          </button>
        </div>
      </aside>
      <main>
        {error && (
          <div className="alert" role="alert">
            {error}
            <button onClick={refresh}>重新连接</button>
            <p>
              首次访问请在终端运行 <code>node dist/cli.js web</code>。
            </p>
          </div>
        )}
        {status?.errors.map((message, i) => (
          <div className="alert" key={`${i}:${message}`} role="alert">
            {message}
          </div>
        ))}
        {page === "memories" || page === "candidates" ? (
          <Library
            key={`${page}:${scope}`}
            scope={scope}
            candidates={page === "candidates"}
            projects={projects}
            version={version}
            onChange={refresh}
          />
        ) : (
          <Operations
            page={page}
            status={status}
            projects={projects}
            onChange={refresh}
          />
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
