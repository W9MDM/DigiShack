import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";

import { Input } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

/**
 * 16px type on touch screens. iOS zooms the whole page into any field smaller than that
 * the moment it is focused, and leaves it zoomed after the keyboard closes.
 */
export const TOUCH_TEXT = "pointer-coarse:text-base";

export type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  /** Required, so a password manager never has to guess which kind of field this is. */
  autoComplete: "current-password" | "new-password";
};

/**
 * A password field with a Show / Hide toggle.
 *
 * The remaining props go to the input itself, so the `aria-describedby` and `aria-invalid`
 * that `Field` clones onto its child reach the real control.
 */
export function PasswordInput({ id, className, autoComplete, ...props }: PasswordInputProps) {
  const [shown, setShown] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Back to dots when the form is sent, so a password is never submitted from a plain text
  // field (which some browsers file under form history) or left on screen while it is checked.
  useEffect(() => {
    const form = toggleRef.current?.form;
    if (!form) return;
    const hide = () => setShown(false);
    form.addEventListener("submit", hide);
    return () => form.removeEventListener("submit", hide);
  }, []);

  function toggle() {
    const next = !shown;
    setShown(next);
    setAnnouncement(next ? "Your password is visible" : "Your password is hidden");
  }

  return (
    <div className="relative">
      <Input
        {...props}
        id={id}
        type={shown ? "text" : "password"}
        autoComplete={autoComplete}
        // A revealed password is a text field, and a phone keyboard would capitalise and
        // "correct" it.
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={cn("pr-16", TOUCH_TEXT, className)}
      />
      <button
        ref={toggleRef}
        type="button"
        onClick={toggle}
        aria-controls={id}
        className="absolute inset-y-0 right-0 flex items-center px-3 text-xs font-medium text-fg-muted hover:text-fg"
      >
        {shown ? "Hide" : "Show"}
        <span className="sr-only"> password</span>
      </button>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
