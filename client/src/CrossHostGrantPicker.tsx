import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Bot as BotIcon, Check, ChevronsUpDown, Monitor, Search } from "lucide-react";
import { Avatar } from "./Avatar.js";
import { CreationDialog } from "./CreationDialog.js";
import { t } from "./i18n.js";

/** `sourceBot` names come from another host: never draw them with this host's
 * avatar or presence, which are keyed by Bot ID alone. */
export type GrantChoiceKind = "sourceHost" | "sourceBot" | "targetBot";
export type GrantChoice = {
  id: string;
  name: string;
  /** Unique in its list; same-name entries carry their ID tail. */
  label: string;
  /** Receiving Bots only. */
  online?: boolean;
  /** Listed for context, not selectable (a host that left the network). */
  unavailable?: string;
};
const LIMIT = 100;
const shortId = (id: string) => id.length > 20 ? `…${id.slice(-6)}` : id;

/** A form field that opens a chooser. Its name stays the field label; the
 * current value is its description, as with the schedule Bot field. */
export function CrossHostGrantField({ label, value, placeholder, problem, expanded, disabled, wide, open, trigger }: {
  label: string; value: string; placeholder: string; problem?: string; expanded: boolean; disabled: boolean; wide?: boolean;
  open: () => void; trigger: RefObject<HTMLButtonElement | null>;
}) {
  const valueId = useId();
  return <div className={`cross-grants-field${wide ? " cross-grants-wide" : ""}`}>
    <span aria-hidden="true">{label}</span>
    <button ref={trigger} type="button" className="cross-grants-select" aria-label={label} aria-describedby={valueId} aria-haspopup="dialog" aria-expanded={expanded} disabled={disabled} onClick={open}>
      <span id={valueId} className="cross-grants-select-value" data-state={problem ? "problem" : value ? "set" : "empty"}>{problem || value || placeholder}</span>
      <ChevronsUpDown size={16} aria-hidden="true"/>
    </button>
  </div>;
}

/** Single choice from a live list. It reports an ID and nothing else: the page
 * decides, against its current data, whether that ID may enter the draft.
 * Closing by any route reports nothing. */
export function CrossHostGrantPicker({ kind, title, context, choices, selected, lockReason, choose, close, returnFocus }: {
  kind: GrantChoiceKind; title: string; context: string; choices: GrantChoice[]; selected: string;
  /** Set while the page may not change its draft. The list stays in place and
   * inert, so a tap in flight cannot land on the page underneath. */
  lockReason: string; choose: (id: string) => void; close: () => void; returnFocus: RefObject<HTMLElement | null>;
}) {
  const [query, setQuery] = useState(""), [active, setActive] = useState("");
  const search = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null), listId = useId();
  // Opening on a touch screen must not raise the keyboard over the list.
  const touch = useMemo(() => matchMedia("(max-width:760px),(hover:none) and (pointer:coarse)").matches, []);
  const optionId = (id: string) => `${listId}-${id}`;
  const needle = query.trim().toLocaleLowerCase(), locked = !!lockReason;
  const matching = choices.filter(choice => !needle || `${choice.label} ${choice.id}`.toLocaleLowerCase().includes(needle));
  const visible = matching.slice(0, LIMIT);
  const enabled = locked ? [] : visible.filter(choice => !choice.unavailable);
  // Nothing is highlighted until an arrow key asks for it, and the highlight
  // is an ID, never a row position: when a refresh or a new query removes that
  // row the highlight is gone, and Enter chooses nothing.
  const current = enabled.find(choice => choice.id === active);
  // Scroll the list itself. scrollIntoView would also scroll the clipped
  // dialog on a short screen and strand its title and search out of reach.
  const reveal = (id: string, centre: boolean) => {
    const box = list.current?.getBoundingClientRect(), row = document.getElementById(optionId(id))?.getBoundingClientRect();
    if (!box || !row) return;
    if (centre) list.current!.scrollTop += row.top - box.top - (box.height - row.height) / 2;
    else if (row.top < box.top) list.current!.scrollTop -= box.top - row.top + 2;
    else if (row.bottom > box.bottom) list.current!.scrollTop += row.bottom - box.bottom + 2;
  };
  useLayoutEffect(() => { reveal(selected, true); }, []);
  useLayoutEffect(() => { if (current) reveal(current.id, false); }, [current?.id]);
  const move = (to: number | "first" | "last") => {
    if (!enabled.length) return;
    const at = current ? enabled.indexOf(current) : -1, chosen = enabled.findIndex(choice => choice.id === selected);
    // The first arrow starts from the current choice when it is in view.
    const next = to === "first" ? 0 : to === "last" ? enabled.length - 1 : at < 0 ? (chosen >= 0 ? chosen : to > 0 ? 0 : enabled.length - 1) : Math.min(enabled.length - 1, Math.max(0, at + to));
    setActive(enabled[next]!.id);
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const inSearch = event.target === search.current;
    if (event.key === "ArrowDown") move(1);
    else if (event.key === "ArrowUp") move(-1);
    else if (event.key === "Home" && !inSearch) move("first");
    else if (event.key === "End" && !inSearch) move("last");
    else if (event.key === "Enter") { event.stopPropagation(); if (current) choose(current.id); }
    else return;
    event.preventDefault();
  };
  const detail = (choice: GrantChoice) => <>
    {kind === "targetBot" && <><i data-online={!!choice.online} aria-hidden="true"/><span>{choice.online ? t("当前在线") : t("当前离线")}</span></>}
    <span className="cross-grants-option-id">ID {shortId(choice.id)}</span>
    {choice.unavailable && <span>{choice.unavailable}</span>}
  </>;
  return <CreationDialog className="cross-grants-picker" showHost={false} title={title} close={close} closeLabel={t("关闭选择")} returnFocus={returnFocus} initialFocus={touch ? list : search}>
    <div className="cross-grants-picker-body" onKeyDown={keyDown}>
      <p className="cross-grants-picker-context"><Monitor size={15} aria-hidden="true"/><span>{context}</span></p>
      {locked && <p className="cross-grants-picker-lock" role="status">{lockReason}</p>}
      <label className="cross-grants-picker-search"><Search size={18} aria-hidden="true"/>
        <input ref={search} type="text" role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={current ? optionId(current.id) : undefined}
          aria-label={t("搜索名称或 ID")} placeholder={t("搜索名称或 ID")} inputMode="search" enterKeyHint="search" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={200}
          value={query} onChange={event => setQuery(event.target.value)}/>
      </label>
      <div ref={list} id={listId} className="cross-grants-picker-list" role="listbox" tabIndex={-1} aria-label={title} aria-activedescendant={current ? optionId(current.id) : undefined}>
        {visible.map(choice => {
          const inert = locked || !!choice.unavailable;
          return <div key={choice.id} id={optionId(choice.id)} className="cross-grants-option" role="option" aria-label={choice.label} aria-describedby={`${optionId(choice.id)}-detail`}
            aria-selected={choice.id === selected} aria-disabled={inert || undefined} data-choice-id={choice.id} data-active={choice.id === current?.id || undefined}
            onClick={() => { if (!inert) choose(choice.id); }}>
            <span className="cross-grants-option-icon" aria-hidden="true">{kind === "targetBot" ? <Avatar kind="bot" id={choice.id} name={choice.name} size={36}/> : kind === "sourceHost" ? <Monitor size={18}/> : <BotIcon size={18}/>}</span>
            <span className="cross-grants-option-copy"><strong>{choice.name}</strong><small id={`${optionId(choice.id)}-detail`}>{detail(choice)}</small></span>
            {choice.id === selected && <Check className="cross-grants-option-check" size={18} aria-hidden="true"/>}
          </div>;
        })}
      </div>
      {!matching.length && <p className="cross-grants-picker-empty" role="status">{kind === "sourceHost" ? t("没有找到匹配的主机。") : t("没有找到匹配的 Bot。")}</p>}
      {matching.length > LIMIT && <p className="cross-grants-picker-more">{t("仅显示前 100 个，请搜索缩小范围。")}</p>}
    </div>
  </CreationDialog>;
}
