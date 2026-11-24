import { useEffect, useState } from "react";
import { Check, CheckCircle2, ChevronDown, ListTodo, LoaderCircle } from "lucide-react";
import type { RunPlanItem } from "../../src/client-protocol/run-plan.js";
import { t, useLocale } from "./i18n.js";

export function RunPlanList({ items, live = false }: { items: readonly RunPlanItem[]; live?: boolean }) {
  useLocale();
  if (!items.length) return null;
  return <ol className="run-plan-list">
    {items.map((item, index) => {
      const stateClass = item.status === "completed" ? "is-completed" : item.status === "in_progress" ? "is-in-progress" : "is-pending";
      return <li key={index} className={`run-plan-item ${stateClass}`}>
        <span className="run-plan-marker" aria-hidden="true">
          {item.status === "completed"
            ? <Check size={11} strokeWidth={2.75}/>
            : item.status === "in_progress"
              ? live ? <LoaderCircle size={12} className="spin"/> : <span className="run-plan-dot"/>
              : <span className="run-plan-ring"/>}
        </span>
        <span className="run-plan-text">{item.content}</span>
        {item.status === "in_progress" && <span className="run-plan-badge">{t("进行中")}</span>}
      </li>;
    })}
  </ol>;
}

export function RunPlanPanel({ items, active }: { items: readonly RunPlanItem[]; active: boolean }) {
  useLocale();
  const [userExpanded, setUserExpanded] = useState<boolean | undefined>(undefined);
  // Expanded automatically while working; collapses gently once the turn settles unless the user chose otherwise.
  const expanded = userExpanded ?? active;
  useEffect(() => {
    if (active) setUserExpanded(undefined);
  }, [active]);

  if (!items.length) return null;
  const total = items.length;
  const completed = items.filter((item) => item.status === "completed").length;
  const inProgress = items.find((item) => item.status === "in_progress");
  const allDone = completed === total;
  const percent = Math.round((completed / total) * 100);
  const subtitle = !expanded
    ? (inProgress?.content ?? (allDone ? t("全部完成") : t("已完成 {0}/{1}", completed, total)))
    : undefined;

  return <section
    className={`run-plan-card${allDone ? " is-complete" : ""}${expanded ? " is-expanded" : " is-collapsed"}`}
    aria-label={t("任务清单")}
  >
    <button
      type="button"
      className="run-plan-header"
      aria-expanded={expanded}
      onClick={() => setUserExpanded(!expanded)}
    >
      <span className="run-plan-icon" aria-hidden="true">
        {allDone
          ? <CheckCircle2 size={14}/>
          : active && inProgress
            ? <LoaderCircle size={14} className="spin"/>
            : <ListTodo size={14}/>}
      </span>
      <span className="run-plan-heading">
        <span className="run-plan-title">{t("任务清单")}</span>
        {subtitle && <span className="run-plan-subtitle">{subtitle}</span>}
      </span>
      <span className="run-plan-count" aria-label={t("已完成 {0} 项，共 {1} 项", completed, total)}>
        {completed}/{total}
      </span>
      <ChevronDown size={14} className="run-plan-chevron" aria-hidden="true"/>
    </button>
    {(!allDone || expanded) && <div className="run-plan-track" aria-hidden="true">
      <div className="run-plan-fill" style={{ width: `${percent}%` }}/>
    </div>}
    {expanded && <div className="run-plan-body"><RunPlanList items={items} live={active}/></div>}
  </section>;
}
