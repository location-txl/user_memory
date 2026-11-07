import { useTranslation } from "react-i18next";
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
import { storageKey } from "./i18n.js";
import { formatError } from "./presentation.js";
import { Library } from "./memory-library.js";
import { Operations, type Status } from "./operations.js";
import "./style.css";

const token = new URLSearchParams(location.hash.slice(1)).get("token");
if (token) {
  sessionStorage.setItem("umem-token", token);
  history.replaceState(null, "", location.pathname);
}
function App() {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const title = t("appTitle");
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = title;
    try {
      localStorage.setItem(storageKey, language);
    } catch {
      /* Storage may be disabled; switching still works. */
    }
  }, [language, title]);
  const [page, setPage] = useState("memories");
  const [scope, setScope] = useState("global");
  const [projects, setProjects] = useState<Project[]>([]);
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState<unknown>(null);
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
          if (live) setError(e);
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
            {t("appTitle")}
            <small>{t("appTagline")}</small>
          </span>
        </a>
        <nav aria-label={t("memoryScope")}>
          <button
            className={
              page === "memories" && scope === "global" ? "selected" : ""
            }
            onClick={() => navigate("memories", "global")}
          >
            <Globe2 size={18} />
            {t("globalMemories")}
          </button>
          <button
            className={page === "candidates" ? "selected" : ""}
            onClick={() => navigate("candidates", "all")}
          >
            <Inbox size={18} />
            {t("reviewQueue")}
            <span className="count">{status?.candidates ?? 0}</span>
          </button>
          <div className="nav-label">{t("projects")}</div>
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
            <p className="nav-empty">{t("automaticProjectRegistration")}</p>
          )}
          <div className="nav-label">{t("manage")}</div>
          {[
            { id: "connections", label: t("connections"), Icon: Cable },
            {
              id: "imports",
              label: t("importMemories"),
              Icon: ArrowDownToLine,
            },
            {
              id: "settings",
              label: t("settingsAndJobs"),
              Icon: SlidersHorizontal,
            },
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
        <label className="language-select">
          <span>Language / 语言</span>
          <select
            aria-label="Language / 语言"
            value={language}
            onChange={(e) => void i18n.changeLanguage(e.target.value)}
          >
            <option value="en">English</option>
            <option value="zh-CN">简体中文</option>
          </select>
        </label>
        <div className="service-state">
          <span className={`dot ${error ? "offline" : ""}`} />
          {error ? t("disconnected") : t("localService")}
          <button aria-label={t("refresh")} onClick={refresh}>
            <RefreshCw size={15} />
          </button>
        </div>
      </aside>
      <main>
        {!!error && (
          <div className="alert" role="alert">
            {formatError(error, t)}
            <button onClick={refresh}>{t("reconnect")}</button>
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
