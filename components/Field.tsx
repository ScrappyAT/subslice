import { useId, type InputHTMLAttributes } from "react";

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  error?: string;
}

// Label, input, and error message as one unit - every form imports this
// instead of hand-wiring htmlFor/id/aria-describedby itself, so getting
// this right once means it's right in all five forms, not four of them.
export default function Field({ label, error, className, ...inputProps }: FieldProps) {
  // useId() rather than a slugified label or the `name` prop: it needs no
  // input to already be unique (two fields could share a label; `name`
  // could theoretically repeat across separate forms rendered together),
  // it works identically whether Field renders on the server or the
  // client without a hydration mismatch, and it costs the caller nothing -
  // they never have to remember to pass a unique id themselves.
  const generatedId = useId();
  const inputId = `${generatedId}-input`;
  const errorId = `${generatedId}-error`;

  return (
    <div>
      <label htmlFor={inputId} className="block text-sm font-medium">
        {label}
      </label>
      <input
        {...inputProps}
        id={inputId}
        aria-invalid={error ? true : undefined}
        // Only present when there is an error, and never pointing at an id
        // that isn't actually rendered - see the answer on what breaks
        // for a screen reader without this.
        aria-describedby={error ? errorId : undefined}
        className={[
          "mt-1 w-full rounded-md border border-gray-400 px-3 py-2",
          // The outline is removed only together with a same-step
          // replacement, never on its own: a 2px high-contrast ring with
          // a 2px offset so it doesn't blend into the input's own border.
          // Applied on every focus (not just keyboard/:focus-visible), so
          // there is no path through this component that ends in no
          // visible focus indicator at all.
          "focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-600",
          "aria-invalid:border-red-600",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      />
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
