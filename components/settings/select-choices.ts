/** One entry in a `select` setting's dropdown. */
export interface SelectChoice {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * What a `select` setting's dropdown lists for the value it holds now.
 *
 * Plain data, so scripts/check-settings-docs.ts can hold it to its two promises without a
 * browser:
 * - A saved value that is not one of the choices is listed first, as itself, rather than
 *   silently snapped to the first option. It stays selected until the operator picks a
 *   real choice, and every real choice is still there to pick.
 * - Nothing stored and no "not set" choice of its own: a disabled placeholder, because
 *   otherwise the browser shows the first choice as if it were chosen, and picking it
 *   changes nothing.
 */
export function selectChoices(
  options: readonly { value: string; label: string }[] | undefined,
  value: string,
): SelectChoice[] {
  const opts = options ?? [];
  const has = (v: string) => opts.some((o) => o.value === v);
  const lead: SelectChoice[] = [];
  if (value !== "" && !has(value)) lead.push({ value, label: `${value} (saved, not one of the choices)` });
  if (value === "" && !has("")) lead.push({ value: "", label: "Not set — choose one", disabled: true });
  return [...lead, ...opts];
}
