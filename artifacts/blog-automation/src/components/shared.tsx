const STATUS_STEPS = ["queued", "researching", "writing", "humanizing", "checking", "retrying", "formatting", "completed"] as const;

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  researching: "Researching",
  writing: "Writing",
  humanizing: "Humanizing",
  checking: "Checking",
  retrying: "Retrying",
  formatting: "Formatting",
  completed: "Completed",
  failed: "Failed",
  flagged: "Flagged",
};

const STATUS_COLORS: Record<string, string> = {
  queued: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  researching: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  writing: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300",
  humanizing: "bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300",
  checking: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
  retrying: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300",
  formatting: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950/50 dark:text-cyan-300",
  completed: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
  flagged: "bg-yellow-100 text-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-300",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      data-testid={`badge-status-${status}`}
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status] ?? "bg-gray-100 text-gray-700"}`}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function PipelineSteps({ currentStatus }: { currentStatus: string }) {
  const currentIdx = STATUS_STEPS.indexOf(currentStatus as typeof STATUS_STEPS[number]);
  const isFailed = currentStatus === "failed" || currentStatus === "flagged";

  return (
    <div className="flex items-center gap-1">
      {STATUS_STEPS.map((step, idx) => {
        const isPast = currentIdx > idx;
        const isCurrent = currentIdx === idx;
        const stepColor = isFailed && isCurrent
          ? "bg-red-500"
          : isPast
          ? "bg-green-500"
          : isCurrent
          ? "bg-blue-500 animate-pulse"
          : "bg-muted-foreground/20";

        return (
          <div key={step} className="flex items-center gap-1">
            <div
              className={`h-1.5 w-1.5 rounded-full transition-colors ${stepColor}`}
              title={STATUS_LABELS[step]}
            />
            {idx < STATUS_STEPS.length - 1 && (
              <div className={`h-px w-4 ${isPast ? "bg-green-400" : "bg-muted-foreground/20"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Display the ZeroGPT AI-detection score (0-100). Lower is better.
 * Green under 20%, amber 20-40%, red above 40%.
 */
export function ZeroGptScore({ score }: { score?: number | null }) {
  if (score == null) return <span className="text-muted-foreground text-sm">—</span>;

  const color =
    score < 20 ? "text-green-600" :
    score < 40 ? "text-amber-600" :
    "text-red-600";

  return (
    <span className={`font-mono text-sm font-medium ${color}`} title="ZeroGPT AI-detection score (lower is better)">
      {score.toFixed(1)}%
    </span>
  );
}
