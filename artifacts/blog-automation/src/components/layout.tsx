import { Link, useLocation } from "wouter";
import { LayoutDashboard, Plus, Activity, History, Moon, Sun } from "lucide-react";
import { useState, useEffect } from "react";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, mobileLabel: "Home" },
  { href: "/new", label: "New Article", icon: Plus, mobileLabel: "New" },
  { href: "/status", label: "Pipeline Status", icon: Activity, mobileLabel: "Status" },
  { href: "/history", label: "History", icon: History, mobileLabel: "History" },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [dark, setDark] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("theme") === "dark";
    }
    return false;
  });

  useEffect(() => {
    if (dark) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  }, [dark]);

  return (
    <div className="min-h-screen flex bg-background">
      {/* Desktop sidebar — hidden on mobile (bottom nav takes its place) */}
      <aside className="hidden md:flex w-56 shrink-0 bg-sidebar border-r border-sidebar-border flex-col">
        <div className="px-5 py-5 border-b border-sidebar-border">
          <div className="flex items-center gap-2.5">
            <div className="h-7 w-7 rounded-md bg-sidebar-primary flex items-center justify-center">
              <span className="text-xs font-bold text-white">B</span>
            </div>
            <div>
              <p className="text-sm font-semibold text-sidebar-foreground leading-tight">BlogAutomator</p>
              <p className="text-xs text-sidebar-foreground/50 leading-tight">Production Pipeline</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const isActive = href === "/" ? location === "/" : location.startsWith(href);
            return (
              <Link key={href} href={href}>
                <button
                  data-testid={`nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors text-left ${
                    isActive
                      ? "bg-sidebar-accent text-sidebar-primary"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {label}
                </button>
              </Link>
            );
          })}
        </nav>

        <div className="px-3 pb-5">
          <button
            data-testid="button-theme-toggle"
            onClick={() => setDark(!dark)}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
          >
            {dark ? <Sun className="h-4 w-4 shrink-0" /> : <Moon className="h-4 w-4 shrink-0" />}
            {dark ? "Light mode" : "Dark mode"}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto pb-20 md:pb-0">
        {/* Mobile-only top bar with brand + theme toggle */}
        <div className="md:hidden sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded bg-sidebar-primary flex items-center justify-center">
              <span className="text-[10px] font-bold text-white">B</span>
            </div>
            <p className="text-sm font-semibold text-foreground">BlogAutomator</p>
          </div>
          <button
            data-testid="button-theme-toggle-mobile"
            onClick={() => setDark(!dark)}
            className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label="Toggle theme"
          >
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>

        <div className="max-w-5xl mx-auto px-4 py-4 md:px-8 md:py-8">
          {children}
        </div>
      </main>

      {/* Mobile bottom nav — only on mobile */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-20 bg-background border-t border-border">
        <div className="grid grid-cols-4">
          {NAV_ITEMS.map(({ href, mobileLabel, icon: Icon }) => {
            const isActive = href === "/" ? location === "/" : location.startsWith(href);
            return (
              <Link key={href} href={href}>
                <button
                  data-testid={`nav-mobile-${mobileLabel.toLowerCase()}`}
                  className={`w-full flex flex-col items-center gap-0.5 py-2.5 text-xs transition-colors ${
                    isActive ? "text-primary" : "text-muted-foreground"
                  }`}
                >
                  <Icon className="h-5 w-5" />
                  {mobileLabel}
                </button>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
