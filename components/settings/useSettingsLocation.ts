import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CATEGORY_HEADING_ID } from "@/components/settings/CategoryView";
import { groupIdFor, rowIdFor } from "@/components/settings/display";
import { isAdvancedSetting, SETTINGS_LOOKUP } from "@/lib/settings/presentation";
import { resolveSettingsLocation, settingsHref } from "@/lib/settings/tabs";

/**
 * Where the settings page is, read from the URL, and getting there.
 *
 * The URL is the source of truth: `?tab=` for a category (the old tab links), `?group=`
 * for a group and `?setting=` for one setting. A support answer, an error message or a
 * bookmark can therefore point at the exact control, and the page scrolls it into view,
 * opens an Advanced disclosure if that is where it lives, and flashes it once.
 */
export function useSettingsLocation({ ready }: { ready: boolean }) {
  const router = useRouter();
  const location = useMemo(
    () =>
      resolveSettingsLocation(
        { tab: router.query.tab, group: router.query.group, setting: router.query.setting },
        SETTINGS_LOOKUP,
      ),
    [router.query.tab, router.query.group, router.query.setting],
  );

  // Explicit open/closed choices win; otherwise a deep link opens what it points into.
  const [advanced, setAdvanced] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const forcedAdvanced =
    location.setting && isAdvancedSetting(location.setting) ? location.group : null;
  const isAdvancedOpen = useCallback(
    (g: string) => advanced[g] ?? forcedAdvanced === g,
    [advanced, forcedAdvanced],
  );
  const isExpanded = useCallback(
    (g: string) => expanded[g] ?? location.group === g,
    [expanded, location.group],
  );
  const toggleAdvanced = useCallback(
    (g: string) => setAdvanced((p) => ({ ...p, [g]: !isAdvancedOpen(g) })),
    [isAdvancedOpen],
  );
  const toggleExpanded = useCallback(
    (g: string) => setExpanded((p) => ({ ...p, [g]: !isExpanded(g) })),
    [isExpanded],
  );

  const [flashId, setFlashId] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  // Bumped when a link is followed, so following the same link twice still scrolls.
  const [nonce, setNonce] = useState(0);
  const firstRun = useRef(true);

  const scrollKey = `${location.tab}|${location.group ?? ""}|${location.setting ?? ""}`;
  useEffect(() => {
    if (!ready) return;
    const initial = firstRun.current;
    firstRun.current = false;
    const targetId = location.setting
      ? rowIdFor(location.setting)
      : location.group
        ? groupIdFor(location.group)
        : CATEGORY_HEADING_ID;
    // A bare /settings needs no jump on arrival — it is already at the top.
    if (initial && !location.group && !location.setting) return;

    const frame = requestAnimationFrame(() => {
      const el = document.getElementById(targetId);
      if (!el) return;
      // A category change only scrolls back up when the heading is out of view.
      if (targetId === CATEGORY_HEADING_ID && el.getBoundingClientRect().top >= 0) return;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      if (targetId !== CATEGORY_HEADING_ID) {
        // Focus follows, for a keyboard or screen-reader user — the heading of a group, the
        // row of a setting — without scrolling again.
        const focusTarget = location.group && !location.setting ? document.getElementById(`${targetId}-title`) : el;
        focusTarget?.focus({ preventScroll: true });
        setFlashId(targetId);
      }
      if (location.group) setActiveGroup(location.group);
    });
    return () => cancelAnimationFrame(frame);
    // location's parts are all in scrollKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey, nonce, ready]);

  useEffect(() => {
    if (!flashId) return;
    const id = setTimeout(() => setFlashId(null), 1600);
    return () => clearTimeout(id);
  }, [flashId]);

  /** Go to a group or a setting on this page. */
  const goTo = useCallback(
    (target: { group?: string; setting?: string; tab?: string }) => {
      const group = target.group ?? (target.setting ? SETTINGS_LOOKUP.groupOfSetting(target.setting) : undefined);
      setNonce((n) => n + 1);
      void router.replace(settingsHref({ tab: target.tab, group, setting: target.setting }), undefined, {
        shallow: true,
        scroll: false,
      });
    },
    [router],
  );

  /** A sidebar link was followed; the URL change itself is the link's. */
  const followed = useCallback(() => setNonce((n) => n + 1), []);

  return {
    location,
    isAdvancedOpen,
    toggleAdvanced,
    isExpanded,
    toggleExpanded,
    flashId,
    activeGroup,
    setActiveGroup,
    goTo,
    followed,
  };
}
