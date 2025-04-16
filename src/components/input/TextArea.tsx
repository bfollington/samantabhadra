import { cn } from "@/lib/utils";
import { useMemo, useRef, useState } from "react";
import { inputClasses } from "./Input";

export type TextAreaProps = Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "size"
> & {
  children?: React.ReactNode;
  className?: string;
  displayContent?: "items-first" | "items-last"; // used for children of component
  initialValue?: string;
  isValid?: boolean;
  onValueChange: ((value: string, isValid: boolean) => void) | undefined;
  preText?: string[] | React.ReactNode[] | React.ReactNode;
  postText?: string[] | React.ReactNode[] | React.ReactNode;
  size?: "sm" | "md" | "base";
};

export const TextArea = ({
  children,
  className,
  displayContent,
  initialValue,
  isValid = true,
  onValueChange,
  preText,
  postText,
  size = "base",
  ...props
}: TextAreaProps) => {
  const [currentValue, setCurrentValue] = useState(initialValue ?? "");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useMemo(() => {
    setCurrentValue(initialValue ?? "");
  }, [initialValue]);

  const updateCurrentValue = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = event.target.value;
    setCurrentValue(newValue);

    if (onValueChange) {
      if (!props.maxLength) {
        onValueChange(newValue, isValid);
      } else {
        onValueChange(newValue.slice(0, props.maxLength), isValid);
      }
    }
  };

  const handlePreTextInputClick = () => {
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  return preText ? (
    // biome-ignore lint/a11y/useKeyWithClickEvents: todo
    <div
      className={cn(
        "has-[:disabled]:ob-disable has-[:enabled]:active:border-ob-border-active has-[:focus]:border-ob-border-active flex cursor-text",
        inputClasses,
        {
          "add-size-sm": size === "sm",
          "add-size-md": size === "md",
          "add-size-base": size === "base",
        },
        className
      )}
      onClick={handlePreTextInputClick}
    >
      <span className="text-ob-base-200 pointer-events-none mr-0.5 flex items-center gap-2 transition-colors select-none">
        {preText}
      </span>

      <textarea
        className={cn(
          "placeholder:text-ob-base-100 w-full bg-transparent focus:outline-none resize-y min-h-[3em]",
          {
            "text-ob-destructive": !isValid,
          }
        )}
        onChange={updateCurrentValue}
        ref={textareaRef}
        value={currentValue}
        {...props}
      />

      <span className="text-ob-base-200 mr-0.5 flex items-center gap-2 transition-colors select-none">
        {postText}
      </span>
    </div>
  ) : (
    <textarea
      className={cn(
        inputClasses,
        {
          "text-ob-destructive transition-colors": !isValid,
          "resize-y": true,
          'min-h-[5em]': true
        },
        className
      )}
      onChange={updateCurrentValue}
      value={currentValue}
      {...props}
    />
  );
};
