import { Link } from "wouter";
import { useMemo } from "react";
import { useGetDashboardStats, useGetActiveArticles, getGetDashboardStatsQueryKey, getGetActiveArticlesQueryKey } from "@workspace/api-client-react";
import type { Article } from "@workspace/api-client-react";
import { FileText, XCircle, Clock, TrendingUp, Plus, ArrowRight } from "lucide-react";
import { StatusBadge, PipelineSteps } from "@/components/shared";

type ActiveArticleCard = Pick<Article, "id" | "topic" | "primaryKeyword" | "status" | "retryCount">;

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isActiveArticleCard(value: unknown): value is ActiveArticleCard {
  if (!isObjectLike(value)) return false;
  return (
    typeof value.id === "number" &&
    Number.isFinite(value.id) &&
    typeof value.topic === "string" &&
    typeof value.primaryKeyword === "string" &&
    typeof value.status === "string" &&
    typeof value.retryCount === "number" &&
    Number.isFinite(value.retryCount)
  );
}

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading, isError: statsError } = useGetDashboardStats({
    query: { refetchInterval: 15000, queryKey: getGetDashboardStatsQueryKey() },
  });
  const { data: active, isLoading: activeLoading, isError: activeError, refetch: refetchActive } = useGetActiveArticles({
    query: { refetchInterval: 10000, queryKey: getGetActiveArticlesQueryKey() },
  });
  const statsPayload = isObjectLike(stats) ? stats : null;
  const failedArticles = asFiniteNumber(statsPayload?.failedArticles) ?? 0;
  const avgZeroGptScore = asFiniteNumber(statsPayload?.avgZeroGptScore);
  const avgPrimaryDensity = asFiniteNumber(statsPayload?.avgPrimaryDensity);
  const hasInvalidStatsPayload = !statsLoading && stats != null && !isObjectLike(stats);

  const rawActiveArticles = useMemo(() => (Array.isArray(active) ? active : []), [active]);
  const activeArticles = useMemo(
    () => rawActiveArticles.filter(isActiveArticleCard),
    [rawActiveArticles],
  );
  const hasInvalidActivePayload =
    !activeLoading &&
    ((active != null && !Array.isArray(active)) ||
      (Array.isArray(active) && activeArticles.length !== rawActiveArticles.length));

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">Blog article production overview</p>
        </div>
        <Link href="/new">
          <button
            data-testid="button-new-article"
            className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 transition-opacity w-full sm:w-auto justify-center"
          >
            <Plus className="h-4 w-4" />
            New Article
          </button>
        </Link>
      </div>

      {/* Stats Grid — two tiles only: AI Score + Primary Density. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard
          label="Avg AI Score"
          value={statsLoading ? "..." : avgZeroGptScore != null ? `${avgZeroGptScore.toFixed(1)}%` : "N/A"}
          icon={<TrendingUp className="h-5 w-5 text-blue-500" />}
          sub="ZeroGPT — lower is better"
          valueClass={
            avgZeroGptScore == null
              ? ""
              : avgZeroGptScore < 20
              ? "text-green-600"
              : avgZeroGptScore < 40
              ? "text-amber-600"
              : "text-red-600"
          }
        />
        <StatCard
          label="Avg Primary Density"
          value={statsLoading ? "..." : avgPrimaryDensity != null ? `${avgPrimaryDensity.toFixed(2)}%` : "N/A"}
          icon={<Clock className="h-5 w-5 text-amber-500" />}
          sub="Target: 1.5–2.0%"
          valueClass={
            avgPrimaryDensity == null
              ? ""
              : avgPrimaryDensity >= 1.5 && avgPrimaryDensity <= 2.0
              ? "text-green-600"
              : avgPrimaryDensity >= 1.3 && avgPrimaryDensity <= 2.2
              ? "text-amber-600"
              : "text-red-600"
          }
        />
      </div>

      {(statsError || hasInvalidStatsPayload) && (
        <div className="border border-red-200 dark:border-red-900 rounded-lg p-4">
          <p className="text-sm text-red-700 dark:text-red-300">
            {statsError
              ? "Couldn't load dashboard stats from the API. Values shown above may be stale or defaulted."
              : "Received an invalid dashboard stats payload. Values shown above were safely defaulted."}
          </p>
        </div>
      )}

      {/* Active Pipeline */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-medium text-foreground">Active Pipeline</h2>
          <Link href="/status">
            <button className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
              View all <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </Link>
        </div>

        {activeLoading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="h-20 bg-muted rounded-lg animate-pulse" />
            ))}
          </div>
        ) : activeError || hasInvalidActivePayload ? (
          <div className="border border-red-200 dark:border-red-900 rounded-lg p-6">
            <p className="text-sm text-red-700 dark:text-red-300">
              Couldn't load active pipeline data. Please try again.
            </p>
            <button
              onClick={() => refetchActive()}
              className="mt-3 text-sm text-primary hover:underline"
            >
              Retry
            </button>
          </div>
        ) : activeArticles.length === 0 ? (
          <div className="border border-dashed border-border rounded-lg p-10 text-center">
            <FileText className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No articles currently in the pipeline</p>
            <Link href="/new">
              <button className="mt-3 text-sm text-primary hover:underline">
                Generate your first article
              </button>
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {activeArticles.map((article: Article) => (
              <Link key={article.id} href={`/article/${article.id}`}>
                <div
                  data-testid={`card-active-${article.id}`}
                  className="bg-card border border-card-border rounded-lg p-4 hover:border-primary/30 transition-colors cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-medium text-foreground truncate">{article.topic}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{article.primaryKeyword}</p>
                    </div>
                    <StatusBadge status={article.status} />
                  </div>
                  <div className="mt-3">
                    <PipelineSteps currentStatus={article.status} />
                  </div>
                  {article.retryCount > 0 && (
                    <p className="text-xs text-amber-600 mt-2">Retry attempt {article.retryCount}/3</p>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Failed articles alert */}
      {!statsError && !hasInvalidStatsPayload && (failedArticles > 0) && (
        <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-lg p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <XCircle className="h-5 w-5 text-red-500 shrink-0" />
            <div>
              <p className="text-sm font-medium text-red-800 dark:text-red-300">
                {failedArticles} article{failedArticles !== 1 ? "s" : ""} failed
              </p>
              <p className="text-xs text-red-600 dark:text-red-400">Check the history page to retry them</p>
            </div>
          </div>
          <Link href="/history">
            <button className="text-sm text-red-700 dark:text-red-400 hover:underline font-medium">
              View failed
            </button>
          </Link>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  sub,
  valueClass = "",
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="bg-card border border-card-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</span>
        {icon}
      </div>
      <p className={`text-2xl font-bold text-foreground ${valueClass}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}
