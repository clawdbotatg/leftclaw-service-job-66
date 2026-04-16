"use client";

import { useEffect, useState } from "react";
import { getRandomSurprisePrompt } from "~~/lib/surpriseMePrompts";

type GenerateFormProps = {
  onGenerate: (prompt: string) => Promise<void>;
  isGenerating: boolean;
  disabled?: boolean;
  disabledReason?: string;
};

const MAX_PROMPT_LENGTH = 280;

const GENERATE_ETA_MS = 30_000;

export const GenerateForm = ({ onGenerate, isGenerating, disabled, disabledReason }: GenerateFormProps) => {
  const [prompt, setPrompt] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!isGenerating) {
      setElapsedMs(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - start), 200);
    return () => clearInterval(id);
  }, [isGenerating]);

  // Cap visual progress at 95% so it doesn't look "done" before the request resolves
  const progressPct = Math.min(95, (elapsedMs / GENERATE_ETA_MS) * 100);
  const secondsElapsed = Math.floor(elapsedMs / 1000);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || isGenerating || disabled) return;
    await onGenerate(prompt.trim());
  };

  const handleSurpriseMe = () => {
    if (isGenerating || disabled) return;
    setPrompt(getRandomSurprisePrompt(MAX_PROMPT_LENGTH));
  };

  const charsRemaining = MAX_PROMPT_LENGTH - prompt.length;
  const isOverLimit = charsRemaining < 0;
  const controlsDisabled = isGenerating || !!disabled;

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-lg mx-auto">
      <div className="form-control w-full">
        <label className="label">
          <span className="label-text font-semibold text-lg">Describe your CLAWD</span>
        </label>
        <textarea
          className="textarea textarea-bordered w-full h-24 text-base"
          placeholder="wearing a cowboy hat with laser eyes..."
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          maxLength={MAX_PROMPT_LENGTH}
          disabled={isGenerating}
        />
        <label className="label flex items-center justify-between gap-2">
          <button
            type="button"
            className="btn btn-ghost btn-xs normal-case gap-1"
            onClick={handleSurpriseMe}
            disabled={controlsDisabled}
            title="Fill the prompt with a random idea"
          >
            <span aria-hidden="true">🎲</span>
            Surprise Me
          </button>
          <span className={`label-text-alt ${isOverLimit ? "text-error" : "text-base-content/60"}`}>
            {charsRemaining} characters remaining
          </span>
        </label>
      </div>

      {disabledReason && <div className="text-sm text-warning mb-2 text-center">{disabledReason}</div>}

      <button
        type="submit"
        className="btn btn-primary w-full text-lg"
        disabled={!prompt.trim() || isGenerating || disabled || isOverLimit}
      >
        {isGenerating ? (
          <>
            <span className="loading loading-spinner loading-sm"></span>
            Generating your CLAWD...
          </>
        ) : (
          "Generate PFP (500,000 CV)"
        )}
      </button>

      {isGenerating && (
        <div className="mt-3">
          <div className="h-2 w-full rounded-full bg-base-300 overflow-hidden">
            <div
              className="h-full bg-primary transition-[width] duration-200 ease-linear"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="text-sm text-base-content/60 text-center mt-2">
            {secondsElapsed < 30
              ? `Generating... ${secondsElapsed}s / ~30s`
              : `Still working... ${secondsElapsed}s (sometimes takes a bit longer)`}
          </p>
        </div>
      )}
    </form>
  );
};
