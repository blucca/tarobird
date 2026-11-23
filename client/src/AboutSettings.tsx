import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronRight, ExternalLink, FileText, LoaderCircle, Search, X } from "lucide-react";
import pkg from "../package.json";
import { t, useLocale } from "./i18n.js";
import "./about-settings.css";

export type AcknowledgementCategory = "npm" | "asset" | "vendored" | "android" | "ios";

export type AcknowledgementEntry = {
  id: string;
  name: string;
  category: AcknowledgementCategory;
  repository: string;
  version: string;
  license: string;
  usage: string;
  location: string;
  licenseText: string;
  noticeText?: string;
};

type AcknowledgementsPayload = {
  version: number;
  entries: AcknowledgementEntry[];
};

const CATEGORIES: Array<"all" | AcknowledgementCategory> = ["all", "npm", "asset", "vendored", "android", "ios"];

export function AboutSettings({ active }: { active: boolean }) {
  useLocale();
  const [view, setView] = useState<"about" | "acknowledgements">("about");
  const [entries, setEntries] = useState<AcknowledgementEntry[] | undefined>();
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | AcknowledgementCategory>("all");
  const [selectedId, setSelectedId] = useState<string>();

  useEffect(() => {
    if (!active) return;
    if (view !== "acknowledgements" || entries !== undefined) return;
    let alive = true;
    setLoadError(false);
    void import("./generated/acknowledgements.json")
      .then((mod) => {
        if (!alive) return;
        const data = mod.default as AcknowledgementsPayload;
        setEntries(Array.isArray(data?.entries) ? data.entries : []);
      })
      .catch(() => {
        if (alive) setLoadError(true);
      });
    return () => { alive = false; };
  }, [active, view, entries]);

  // Reset sub-view and filters when leaving the About section so reopening starts cleanly at About.
  useEffect(() => {
    if (!active) {
      setView("about");
      setSelectedId(undefined);
      setQuery("");
      setCategory("all");
    }
  }, [active]);

  const categoryLabel = (cat: "all" | AcknowledgementCategory): string => {
    switch (cat) {
      case "all": return t("全部");
      case "npm": return t("npm 依赖");
      case "asset": return t("字体与素材");
      case "vendored": return t("内置组件");
      case "android": return "Android";
      case "ios": return "iOS";
    }
  };

  const filtered = useMemo(() => {
    if (!entries) return [];
    const needle = query.trim().toLocaleLowerCase();
    return entries.filter((entry) => {
      if (category !== "all" && entry.category !== category) return false;
      if (!needle) return true;
      return entry.name.toLocaleLowerCase().includes(needle)
        || entry.license.toLocaleLowerCase().includes(needle)
        || entry.usage.toLocaleLowerCase().includes(needle)
        || entry.location.toLocaleLowerCase().includes(needle)
        || entry.repository.toLocaleLowerCase().includes(needle);
    });
  }, [entries, category, query]);

  const selectedEntry = selectedId ? entries?.find((item) => item.id === selectedId) : undefined;

  if (view === "about") {
    return (
      <div className="about-settings">
        <div className="about-hero">
          <div className="about-hero-title">
            <strong>TaroBird</strong>
            <span className="about-version">v{pkg.version}</span>
          </div>
          <p className="about-hero-summary">
            {t("桌面与移动端 AI 工作台，支持自托管主机与多引擎协作。")}
          </p>
          <dl className="about-meta">
            <div>
              <dt>{t("项目协议")}</dt>
              <dd><code>AGPL-3.0-only</code></dd>
            </div>
            <div>
              <dt>{t("版本号")}</dt>
              <dd><code>{pkg.version}</code></dd>
            </div>
          </dl>
        </div>

        <div className="network-settings-options">
          <button
            type="button"
            className="network-settings-option"
            data-about-action="acknowledgements"
            onClick={() => setView("acknowledgements")}
          >
            <FileText size={20} aria-hidden="true" />
            <span>
              <strong>{t("致谢")}</strong>
              <small>{t("查看随应用发布的第三方代码、字体、图标与开源许可")}</small>
            </span>
            <ChevronRight size={17} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  if (selectedEntry) {
    return (
      <div className="about-acknowledgements-detail">
        <button
          type="button"
          className="about-back-button"
          onClick={() => setSelectedId(undefined)}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          <span>{t("返回致谢列表")}</span>
        </button>

        <header className="about-detail-header">
          <div>
            <h4>{selectedEntry.name}</h4>
            <p className="about-detail-sub">
              <span>{categoryLabel(selectedEntry.category)}</span>
              {selectedEntry.version && <> · <code>{selectedEntry.version}</code></>}
            </p>
          </div>
          <span className="about-license-badge">{selectedEntry.license}</span>
        </header>

        <dl className="about-detail-meta">
          <div>
            <dt>{t("用途")}</dt>
            <dd>{selectedEntry.usage}</dd>
          </div>
          <div>
            <dt>{t("仓库位置")}</dt>
            <dd><code>{selectedEntry.location}</code></dd>
          </div>
          {selectedEntry.repository && (
            <div>
              <dt>{t("来源地址")}</dt>
              <dd>
                <a href={selectedEntry.repository} target="_blank" rel="noreferrer noopener" className="about-repo-link">
                  <span>{selectedEntry.repository}</span>
                  <ExternalLink size={13} aria-hidden="true" />
                </a>
              </dd>
            </div>
          )}
        </dl>

        {selectedEntry.noticeText && (
          <div className="about-license-section">
            <h5>{t("附加声明（NOTICE）")}</h5>
            <pre className="about-license-text">{selectedEntry.noticeText}</pre>
          </div>
        )}

        <div className="about-license-section">
          <h5>{t("许可全文")}</h5>
          <pre className="about-license-text" data-license-text>{selectedEntry.licenseText}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="about-acknowledgements">
      <div className="about-ack-topbar">
        <button
          type="button"
          className="about-back-button"
          onClick={() => { setView("about"); setQuery(""); setCategory("all"); }}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          <span>{t("返回关于")}</span>
        </button>
        {entries && (
          <span className="about-ack-count">
            {t("共 {0} 项", filtered.length)}
          </span>
        )}
      </div>

      <p className="settings-lede">
        {t("以下第三方开源项目、字体、图标与平台依赖由统一清单生成，点击任意条目可查看完整许可文本。")}
      </p>

      <div className="about-search-box">
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          aria-label={t("搜索致谢项目")}
          placeholder={t("按名称、协议或用途搜索…")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button
            type="button"
            className="icon-button about-search-clear"
            aria-label={t("清空搜索")}
            onClick={() => setQuery("")}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="about-category-filters" role="tablist" aria-label={t("按类别筛选")}>
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            type="button"
            role="tab"
            aria-selected={category === cat}
            className={`about-category-chip${category === cat ? " is-active" : ""}`}
            onClick={() => setCategory(cat)}
          >
            {categoryLabel(cat)}
          </button>
        ))}
      </div>

      {loadError ? (
        <p className="error-text" role="alert">{t("未能加载致谢清单，请稍后重试。")}</p>
      ) : entries === undefined ? (
        <p className="muted about-loading" role="status">
          <LoaderCircle size={15} className="spin" aria-hidden="true" />
          <span>{t("正在加载致谢清单…")}</span>
        </p>
      ) : filtered.length === 0 ? (
        <p className="muted about-empty" role="status">{t("没有匹配的第三方条目。")}</p>
      ) : (
        <ul className="about-ack-list" aria-label={t("致谢列表")}>
          {filtered.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className="about-ack-row"
                data-ack-id={entry.id}
                onClick={() => setSelectedId(entry.id)}
              >
                <span className="about-ack-row-main">
                  <span className="about-ack-row-title">
                    <strong>{entry.name}</strong>
                    <span className="about-license-badge">{entry.license}</span>
                  </span>
                  <small className="about-ack-row-desc">
                    {entry.version ? `${entry.version} · ` : ""}{entry.usage}
                  </small>
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
