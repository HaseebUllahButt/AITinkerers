"use client";

import type { DashboardStats } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Target, PenLine, Newspaper, MailCheck, TrendingUp } from "lucide-react";

interface ScorecardsProps {
  stats: DashboardStats;
  loading?: boolean;
}

export function Scorecards({ stats, loading }: ScorecardsProps) {
  const cards = [
    {
      label: "Total Prospects",
      value: stats.totalProspects.toLocaleString(),
      description: "scored author profiles",
      icon: Target,
      trend: stats.totalProspects > 0 ? "up" : null,
    },
    {
      label: "Authors",
      value: stats.totalAuthors.toLocaleString(),
      description: "unique writers tracked",
      icon: PenLine,
      trend: stats.totalAuthors > 0 ? "up" : null,
    },
    {
      label: "Publications",
      value: stats.totalPublications.toLocaleString(),
      description: "distinct publishers",
      icon: Newspaper,
      trend: null,
    },
    {
      label: "Contactable",
      value: `${stats.contactablePercent}%`,
      description: "have email or social",
      icon: MailCheck,
      trend: stats.contactablePercent > 50 ? "up" : stats.contactablePercent > 0 ? null : null,
    },
    {
      label: "New This Week",
      value: stats.newThisWeek.toLocaleString(),
      description: "discovered in 7 days",
      icon: TrendingUp,
      trend: stats.newThisWeek > 0 ? "up" : null,
    },
  ];

  if (loading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-4 rounded" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16 mb-2" />
              <Skeleton className="h-3 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{c.label}</CardTitle>
            <c.icon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{c.value}</div>
            <p className="text-xs text-muted-foreground mt-1">{c.description}</p>
            {c.trend && (
              <div className="mt-2 flex items-center text-xs text-success">
                <TrendingUp className="mr-1 h-3 w-3" />
                Active
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
