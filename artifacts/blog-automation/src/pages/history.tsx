import { useState } from "react";
import { Link } from "wouter";
import { useListArticles, useDeleteArticle, useRetryArticle, getListArticlesQueryKey } from "@workspace/api-client-react";
import type { Article } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { StatusBadge, ZeroGptScore } from "@/components/shared";
import { Trash2, RefreshCw, Eye, ExternalLink, Filter } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";

const STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "flagged", label: "Flagged" },
];

export default function History() {
  const [statusFilter, setStatusFilter] = useState("");
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: articles, isLoading } = useListArticles(
    statusFilter ? { status: statusFilter } : undefined,
    { query: { refetchInterval: 20000, queryKey: getListArticlesQueryKey(statusFilter ? { status: statusFilter } : undefined) } }
  );

  const deleteArticle = useDeleteArticle({
    mutation: {
      // Optimistic delete: remove the row from cache immediately so the UI
      // updates without waiting for the server round trip. If the call fails,
      // we roll back to the snapshot we took before the optimistic update.
      onMutate: async ({ id }) => {
        console.log("[delete] Starting optimistic delete for article", id);
        const queryKey = getListArticlesQueryKey();
        await qc.cancelQueries({ queryKey });
        const previous = qc.getQueriesData<Article[]>({ queryKey });
        // Update every cached list query (filtered or unfiltered).
        qc.setQueriesData<Article[]>({ queryKey }, (old) =>
          old ? old.filter((a) => a.id !== id) : old,
        );
        return { previous };
      },
      onError: (err, _vars, context) => {
        // Log the actual error to the console so we can see what went wrong
        // (delete-not-working is otherwise invisible if the optimistic update
        // rolls back silently).
        console.error("Article delete failed:", err);
        // Roll back every snapshot we took. Cast through unknown because the
        // generated mutation type defaults TContext to unknown, and we can't
        // override that generic without also providing the TError generic.
        const ctx = context as { previous?: Array<[readonly unknown[], Article[] | undefined]> } | undefined;
        if (ctx?.previous) {
          for (const [key, value] of ctx.previous) {
            qc.setQueryData(key, value);
          }
        }
        const errMessage = err instanceof Error ? err.message : "Unknown error";
        toast({
          title: "Failed to delete article",
          description: errMessage,
          variant: "destructive",
        });
      },
      onSettled: () => {
        console.log("[delete] Settled — invalidating list queries");
        // Reconcile cache with the server once the mutation settles
        // (success or failure). This catches edge cases like a successful
        // delete that left other queries stale.
        qc.invalidateQueries({ queryKey: getListArticlesQueryKey() });
      },
      onSuccess: (_data, vars) => {
        console.log("[delete] Server confirmed delete for article", vars.id);
        toast({ title: "Article deleted" });
      },
    },
  });

  const retryArticle = useRetryArticle({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListArticlesQueryKey() });
        toast({ title: "Article queued for retry" });
      },
    },
  });

  const displayed = (articles ?? []).filter((a: Article) =>
    !statusFilter || a.status === statusFilter
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Article History</h1>
          <p className="text-sm text-muted-foreground mt-1">All completed, failed, and flagged articles</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        <Filter className="h-4 w-4 text-muted-foreground shrink-0" />
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            data-testid={`filter-${f.value || "all"}`}
            onClick={() => setStatusFilter(f.value)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
              statusFilter === f.value
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-16 bg-muted rounded-lg animate-pulse" />
          ))}
        </div>
      ) : displayed.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-16 text-center">
          <p className="text-sm text-muted-foreground">No articles found{statusFilter ? ` with status "${statusFilter}"` : ""}.</p>
          <Link href="/new">
            <button className="mt-3 text-sm text-primary hover:underline">Generate your first article</button>
          </Link>
        </div>
      ) : (
        <>
          {/* Mobile card list — shown below md (768px) */}
          <div className="md:hidden space-y-2">
            {displayed.map((article: Article) => (
              <Link key={article.id} href={`/article/${article.id}`}>
                <div
                  data-testid={`card-article-${article.id}`}
                  className="bg-card border border-card-border rounded-lg p-3 active:bg-muted/40 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-foreground text-sm truncate">{article.title || article.topic}</p>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{article.primaryKeyword}</p>
                    </div>
                    <StatusBadge status={article.status} />
                  </div>
                  <div className="flex items-center gap-3 mt-2 text-xs">
                    <span className="text-muted-foreground">
                      AI: <ZeroGptScore score={article.zeroGptScore} />
                    </span>
                    {article.primaryKeywordDensity != null && (
                      <span className={`font-mono ${
                        article.primaryKeywordDensity >= 1.0 && article.primaryKeywordDensity <= 2.5
                          ? "text-green-600" : "text-amber-600"
                      }`}>
                        Density: {article.primaryKeywordDensity.toFixed(1)}%
                      </span>
                    )}
                    {article.faqCount != null && (
                      <span className={`font-mono ${
                        (article.faqCount >= 4 && article.faqCount <= 8) ? "text-green-600" : "text-amber-600"
                      }`}>
                        FAQs: {article.faqCount}
                      </span>
                    )}
                    <span className="text-muted-foreground ml-auto whitespace-nowrap">
                      {formatDistanceToNow(new Date(article.createdAt), { addSuffix: true })}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>

          {/* Desktop/tablet table — shown md+ */}
          <div className="hidden md:block bg-card border border-card-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">Article</th>
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">Status</th>
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">AI Score</th>
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">Keyword %</th>
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">FAQs</th>
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">Date</th>
                  <th className="text-right py-3 px-4 font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {displayed.map((article: Article) => (
                  <tr
                    key={article.id}
                    data-testid={`row-article-${article.id}`}
                    className="hover:bg-muted/30 transition-colors"
                  >
                    <td className="py-3 px-4">
                      <div className="max-w-xs">
                        <p className="font-medium text-foreground truncate">{article.title || article.topic}</p>
                        <p className="text-xs text-muted-foreground truncate">{article.primaryKeyword}</p>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <StatusBadge status={article.status} />
                    </td>
                    <td className="py-3 px-4">
                      <ZeroGptScore score={article.zeroGptScore} />
                    </td>
                    <td className="py-3 px-4">
                      {article.primaryKeywordDensity != null ? (
                        <span className={`font-mono text-xs ${
                          article.primaryKeywordDensity >= 1.0 && article.primaryKeywordDensity <= 2.5
                            ? "text-green-600" : "text-amber-600"
                        }`} title="Target: 1.0–2.5%">
                          {article.primaryKeywordDensity.toFixed(1)}%
                        </span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="py-3 px-4">
                      {article.faqCount != null ? (
                        <span className={`font-mono text-xs ${
                          (article.faqCount >= 4 && article.faqCount <= 8) ? "text-green-600" : "text-amber-600"
                        }`} title="Target: 4–8">
                          {article.faqCount}
                        </span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="py-3 px-4 text-xs text-muted-foreground whitespace-nowrap">
                      {formatDistanceToNow(new Date(article.createdAt), { addSuffix: true })}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-end gap-1">
                        <Link href={`/article/${article.id}`}>
                          <button
                            data-testid={`button-view-${article.id}`}
                            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                            title="View"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                        </Link>
                        {article.googleDocUrl && (
                          <a href={article.googleDocUrl} target="_blank" rel="noopener noreferrer">
                            <button className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Open Google Doc">
                              <ExternalLink className="h-4 w-4" />
                            </button>
                          </a>
                        )}
                        {(article.status === "failed" || article.status === "flagged") && (
                          <button
                            data-testid={`button-retry-${article.id}`}
                            onClick={() => retryArticle.mutate({ id: article.id })}
                            className="p-1.5 rounded text-amber-500 hover:text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950/20 transition-colors"
                            title="Retry"
                          >
                            <RefreshCw className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          data-testid={`button-delete-${article.id}`}
                          onClick={() => {
                            if (confirm("Delete this article?")) {
                              deleteArticle.mutate({ id: article.id });
                            }
                          }}
                          className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        </>
      )}
    </div>
  );
}
