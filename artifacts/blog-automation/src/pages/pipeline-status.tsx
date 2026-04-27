import { Link } from "wouter";
import { useGetActiveArticles, useGetArticleLogs, getGetActiveArticlesQueryKey } from "@workspace/api-client-react";
import type { Article } from "@workspace/api-client-react";
import { useState } from "react";
import { StatusBadge, PipelineSteps } from "@/components/shared";
import { ChevronDown, ChevronUp, RefreshCw, Clock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export default function PipelineStatus() {
  const { data: articles, isLoading, refetch } = useGetActiveArticles({
    query: { refetchInterval: 5000, queryKey: getGetActiveArticlesQueryKey() },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Pipeline Status</h1>
          <p className="text-sm text-muted-foreground mt-1">Real-time view of articles in progress</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-green-500 animate-pulse" />
            Auto-refreshing every 3s
          </span>
          <button
            data-testid="button-refresh"
            onClick={() => refetch()}
            className="p-2 rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-32 bg-muted rounded-lg animate-pulse" />
          ))}
        </div>
      ) : !articles || articles.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-16 text-center">
          <Clock className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
          <h3 className="font-medium text-foreground mb-1">No articles in pipeline</h3>
          <p className="text-sm text-muted-foreground mb-4">All caught up. Start a new article to see it here.</p>
          <Link href="/new">
            <button className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 transition-opacity">
              New Article
            </button>
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {articles.map((article: Article) => (
            <ArticleStatusCard key={article.id} article={article} />
          ))}
        </div>
      )}
    </div>
  );
}

function ArticleStatusCard({ article }: { article: Article }) {
  const [expanded, setExpanded] = useState(false);
  const { data: logs } = useGetArticleLogs(article.id, {
    query: {
      enabled: expanded,
      queryKey: [`/api/articles/${article.id}/logs`],
      refetchInterval: expanded ? 5000 : false,
    },
  });

  return (
    <div
      data-testid={`card-pipeline-${article.id}`}
      className="bg-card border border-card-border rounded-lg overflow-hidden"
    >
      <div className="p-5">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="min-w-0">
            <Link href={`/article/${article.id}`}>
              <p className="font-semibold text-foreground hover:text-primary transition-colors cursor-pointer truncate">
                {article.topic}
              </p>
            </Link>
            <p className="text-sm text-muted-foreground mt-0.5">{article.primaryKeyword}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <StatusBadge status={article.status} />
            <button
              data-testid={`button-expand-${article.id}`}
              onClick={() => setExpanded(!expanded)}
              className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
            >
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <PipelineSteps currentStatus={article.status} />

        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-muted-foreground">
            Started {formatDistanceToNow(new Date(article.createdAt), { addSuffix: true })}
          </span>
          {article.retryCount > 0 && (
            <span className="text-xs text-amber-600 font-medium">Retry {article.retryCount}/3</span>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-5 py-4 bg-muted/30">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Pipeline Logs</p>
          {!logs || logs.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No logs yet...</p>
          ) : (
            <div className="space-y-2">
              {logs.map((log) => (
                <div key={log.id} className="flex items-start gap-3 text-xs">
                  <div className={`mt-0.5 h-2 w-2 rounded-full shrink-0 ${
                    log.status === "completed" ? "bg-green-500" :
                    log.status === "failed" ? "bg-red-500" : "bg-blue-500 animate-pulse"
                  }`} />
                  <div className="min-w-0">
                    <span className="font-medium text-foreground capitalize">{log.stepName.replace(/_/g, " ")}</span>
                    {log.details && <p className="text-muted-foreground truncate">{log.details}</p>}
                  </div>
                  <span className="text-muted-foreground shrink-0 ml-auto">
                    {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
