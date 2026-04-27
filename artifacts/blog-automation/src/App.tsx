import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider, keepPreviousData } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Layout from "@/components/layout";
import Dashboard from "@/pages/dashboard";
import NewArticle from "@/pages/new-article";
import PipelineStatus from "@/pages/pipeline-status";
import History from "@/pages/history";
import ArticleDetail from "@/pages/article-detail";
import NotFound from "@/pages/not-found";

/**
 * Query client tuned for "smooth feel":
 *   - placeholderData: keepPreviousData so the UI never blanks during a refetch.
 *     This is the single biggest perceived-speed win. When polling kicks in, the
 *     old data stays on screen until the new data arrives, so users see a
 *     stable interface instead of flickering loading states.
 *   - staleTime: 30s means navigating between pages reuses cached data
 *     instantly when you go back to a page you've already visited.
 *   - gcTime: 5min keeps cached data around for the duration of a typical
 *     session, so revisits don't trigger a fresh network hit.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      placeholderData: keepPreviousData,
      refetchOnWindowFocus: false,
    },
  },
});

function getRouterBase(baseUrl: string): string | undefined {
  const trimmed = baseUrl.trim();
  if (trimmed === "" || trimmed === "/") return undefined;

  const withoutTrailingSlash = trimmed.replace(/\/+$/, "");

  return withoutTrailingSlash.startsWith("/")
    ? withoutTrailingSlash
    : `/${withoutTrailingSlash}`;
}

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/new" component={NewArticle} />
        <Route path="/status" component={PipelineStatus} />
        <Route path="/history" component={History} />
        <Route path="/article/:id" component={ArticleDetail} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  const routerBase = getRouterBase(import.meta.env.BASE_URL);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={routerBase}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
