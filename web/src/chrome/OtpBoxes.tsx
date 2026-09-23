import { useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * The six-box TOTP code entry both code-checking cards draw — /settings' enrolment and
 * /login's challenge — ported from the server layout's `OtpBoxes`. One definition for both,
 * because a second copy is exactly how G30 happened.
 *
 * The boxes are unnamed; the code the enclosing form submits is the ONE hidden `code` input,
 * which is what the server-rendered stitching script filled (G30: six named boxes and no
 * stitching posted `code=""` and could never verify). Typing keeps one digit per box and
 * advances, Backspace in an empty box steps back, and a paste spreads across all six.
 */
export function OtpBoxes({ invalid }: { invalid: boolean }): ReactNode {
  const [digits, setDigits] = useState<string[]>(() => Array.from({ length: 6 }, () => ""));
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  const put = (index: number, value: string): void => {
    setDigits((held) => held.map((digit, at) => (at === index ? value : digit)));
  };

  return (
    <>
      <input type="hidden" name="code" value={digits.join("")} />
      <div className="otp" data-otp>
        {digits.map((digit, i) => (
          <input
            key={i}
            ref={(element) => {
              boxes.current[i] = element;
            }}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={1}
            autoComplete="one-time-code"
            aria-label={`Digit ${i + 1}`}
            aria-invalid={invalid ? "true" : undefined}
            autoFocus={i === 0}
            value={digit}
            onChange={(event) => {
              const typed = event.target.value.replace(/[^0-9]/g, "").slice(-1);
              put(i, typed);
              if (typed !== "") boxes.current[i + 1]?.focus();
            }}
            onKeyDown={(event) => {
              if (event.key === "Backspace" && digit === "") boxes.current[i - 1]?.focus();
            }}
            onPaste={(event) => {
              const text = event.clipboardData.getData("text").replace(/[^0-9]/g, "");
              if (text === "") return;
              event.preventDefault();
              setDigits((held) => held.map((_, at) => text[at] ?? ""));
              boxes.current[Math.min(text.length, 6) - 1]?.focus();
            }}
          />
        ))}
      </div>
    </>
  );
}
