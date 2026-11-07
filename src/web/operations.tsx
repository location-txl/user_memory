import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { Check, Copy, RefreshCw, Upload, Terminal } from "lucide-react";
import type { Project } from "../contracts.js";
import type { Config } from "../config.js";
import { cliCommand } from "../cli-command.js";
import { api } from "./api.js";
import type en from "./locales/en.js";
import { formatDate, formatError } from "./presentation.js";

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
  { id: "codex", name: "Codex", mode: "hooksWithMcp" },
  { id: "zcode", name: "ZCode", mode: "hooksWithMcp" },
  { id: "claude", name: "Claude Code", mode: "hooksWithMcp" },
  { id: "pi", name: "Pi", mode: "extensionWithMcp" },
  { id: "deepseek", name: "DeepSeek Harness", mode: "cordisPluginWithMcp" },
  { id: "hermes", name: "Hermes", mode: "memoryProviderWithMcp" },
] as const;
const jobStateKeys: Partial<Record<string, keyof typeof en>> = {
  pending: "pendingExtraction",
  running: "extracting",
  done: "done",
  failed: "failed",
};
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
  const { t, i18n } = useTranslation();
  if (page === "imports")
    return <ImportMemory projects={projects} onChange={onChange} />;
  if (page === "settings")
    return <Settings status={status} onChange={onChange} />;
  return (
    <div className="management">
      <header className="page-header">
        <div>
          <h1>{t("connections")}</h1>
          <p>{t("connectionsDescription")}</p>
        </div>
      </header>
      <div className="instruction">
        <Terminal size={22} />
        <div>
          <h2>{t("installConnection")}</h2>
          <p>{t("installInstructions", { flag: "--dry-run" })}</p>
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
                  <span className="muted">{t(h.mode)}</span>
                </div>
                <span
                  className={`connection ${receipt?.captured_at && receipt.recalled_at ? "connected" : ""}`}
                >
                  {receipt?.captured_at && receipt.recalled_at
                    ? t("captureAndRecallVerified")
                    : receipt
                      ? t("verificationIncomplete")
                      : t("noConnection")}
                </span>
              </div>
              <div className="host-evidence">
                <span>
                  {t("lastCapture")}
                  <b>{formatDate(receipt?.captured_at, i18n)}</b>
                </span>
                <span>
                  {t("lastRecall")}
                  <b>{formatDate(receipt?.recalled_at, i18n)}</b>
                </span>
              </div>
              <Command value={`${cliCommand(status?.home)} setup ${h.id}`} />
            </article>
          );
        })}
      </div>
      <section className="acceptance">
        <h2>{t("verifyAcrossTools")}</h2>
        <ol>
          <li>{t("verificationStatePreference")}</li>
          <li>{t("verificationCheckExtraction")}</li>
          <li>{t("verificationCheckRecall")}</li>
          <li>{t("verificationCheckWithdrawal")}</li>
        </ol>
        <p className="muted">{t("connectionEvidenceHint")}</p>
      </section>
    </div>
  );
}
function Command({ value }: { value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="command">
      <code>{value}</code>
      <button
        aria-label={t("copyCommand")}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(
            () => setCopied(true),
            () => setError(true),
          );
        }}
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
      {!!error && <span role="alert">{t("copyCommandFailed")}</span>}
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
  const { t } = useTranslation();
  const [path, setPath] = useState("");
  const [scope, setScope] = useState("global");
  const [files, setFiles] = useState<Preview[]>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
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
      setError(e);
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
      setNotice(String(result.length));
      setFiles(undefined);
      onChange();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="management narrow">
      <header className="page-header">
        <div>
          <h1>{t("importMemories")}</h1>
          <p>{t("importDescription")}</p>
        </div>
      </header>
      <section className="form-section">
        <h2>{t("chooseImportLocation")}</h2>
        <p className="muted">{t("importLocationHint")}</p>
        <label className="field">
          {t("absolutePath")}
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t("importPathPlaceholder")}
          />
        </label>
        <label className="field">
          {t("importInto")}
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="global">{t("globalMemories")}</option>
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
          {t("previewFiles")}
        </button>
      </section>
      {!!error && (
        <div className="alert" role="alert">
          {formatError(error, t, { title: t("filenameWithoutExtension") })}
        </div>
      )}
      {notice && (
        <div className="success" role="status">
          {notice === "saved"
            ? t("settingsSaved")
            : t("importComplete", { total: notice })}
        </div>
      )}
      {files && (
        <section className="import-preview">
          <h2>{t("previewCount", { count: files.length })}</h2>
          <p className="muted">{t("importIndexHint")}</p>
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
                  {f.index ? t("indexOrSummary") : ""}
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
            {t("importCount", { count: selected.size })}
          </button>
        </section>
      )}
    </div>
  );
}
function Settings({ status, onChange }: { status?: Status; onChange(): void }) {
  const { t, i18n } = useTranslation();
  const [config, setConfig] = useState<Config>();
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<Config>("/config").then(setConfig, (e) => setError(e));
  }, []);
  return (
    <div className="management narrow">
      <header className="page-header">
        <div>
          <h1>{t("settingsAndJobs")}</h1>
          <p>{t("settingsDescription")}</p>
        </div>
        <button onClick={onChange}>
          <RefreshCw size={16} />
          {t("refresh")}
        </button>
      </header>
      {!!error && (
        <div className="alert" role="alert">
          {formatError(error, t)}
        </div>
      )}
      {notice && (
        <div className="success" role="status">
          {notice === "saved"
            ? t("settingsSaved")
            : t("importComplete", { total: notice })}
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
              setNotice("saved");
              onChange();
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>{t("automaticExtraction")}</h2>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={config.extractionEnabled}
              onChange={(e) =>
                setConfig({ ...config, extractionEnabled: e.target.checked })
              }
            />
            {t("automaticallyProcessEvidence")}
          </label>
          <p className="muted">{t("extractionPauseHint")}</p>
          <div className="form-columns">
            <label className="field">
              {t("codexExecutable")}
              <input
                required
                value={config.codexPath}
                onChange={(e) =>
                  setConfig({ ...config, codexPath: e.target.value })
                }
              />
            </label>
            <label className="field">
              {t("modelPlaceholder")}
              <input
                value={config.model ?? ""}
                onChange={(e) =>
                  setConfig({ ...config, model: e.target.value || undefined })
                }
              />
            </label>
          </div>
          <label className="field">
            {t("extractionIdleSeconds")}
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
            {t("saveSettings")}
          </button>
        </form>
      )}
      <section className="form-section">
        <h2>{t("dataLocation")}</h2>
        <p className="file-path">{status?.home ?? t("loading")}</p>
        <p className="muted">{t("storageDescription")}</p>
        <Command
          value={`${cliCommand(status?.home)} export /absolute/path/memory-backup`}
        />
      </section>
      <section className="jobs">
        <h2>{t("recentExtractionJobs")}</h2>
        {status?.jobs.length ? (
          status.jobs.map((j) => {
            const stateKey = jobStateKeys[j.state];
            return (
              <article key={j.id}>
                <div>
                  <b>
                    #{j.id} {j.agent}
                  </b>
                  <span className={j.state === "failed" ? "failed" : "muted"}>
                    {stateKey && t(stateKey)}
                  </span>
                  <time>{formatDate(j.updated_at, i18n)}</time>
                </div>
                {j.error && <pre>{j.error}</pre>}
                {j.state === "failed" && (
                  <button
                    onClick={() => {
                      void api(`/jobs/${j.id}/retry`, { method: "POST" }).then(
                        onChange,
                        (e) => setError(e),
                      );
                    }}
                  >
                    {t("retryJob")}
                  </button>
                )}
              </article>
            );
          })
        ) : (
          <p className="muted">{t("noExtractionJobs")}</p>
        )}
      </section>
    </div>
  );
}
