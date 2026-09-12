// Shared shapes for the indexing + CWV report (report-only; assembled in-memory per run and
// returned to the UI — nothing here is persisted).
import type { CoveragePrediction, Issue } from "./classify";
import type { CwvResult } from "./cwv";
import type { GateResult, Verdict } from "./gate";
import type { RenderMode } from "./renderMode";
import type { ChangeRequestPreview } from "./routing";

export interface AnalyzedUrl {
  url: string;
  path: string;
  template: string;
  isMoney: boolean;
  httpStatus: number;
  isRedirect: boolean;
  renderMode: RenderMode;
  jsGated: boolean;
  rawWords: number;
  renderedWords: number;
  uniquenessRatio: number;
  canonical: string | null;
  gate: GateResult;
  issues: Issue[];
  predicted: CoveragePrediction;
  renderReasons: string[];
  /** Live Google Search Console coverage state, when a service account is configured. */
  gsc?: { coverageState?: string; verdict?: string; lastCrawlTime?: string } | null;
  error?: string;
}

export interface TemplateSummary {
  template: string;
  urlCount: number;
  /** Dominant render mode across the template's sampled URLs. */
  renderMode: RenderMode;
  jsGatedCount: number;
  moneyPage: boolean;
  sampleUrl: string;
  verdicts: Record<Verdict, number>;
  cwv?: CwvResult;
}

export interface IndexingReport {
  target: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  playwrightEnabled: boolean;
  pagespeedKey: boolean;
  /** True when a GSC service account is configured, so `urls[].gsc` holds live coverage. */
  gscConfigured: boolean;
  limit: number;
  discovered: number;
  analyzed: number;
  counts: {
    verdicts: Record<Verdict, number>;
    jsGated: number;
    templates: number;
    issues: number;
    p0: number;
  };
  templates: TemplateSummary[];
  urls: AnalyzedUrl[];
  cwv: CwvResult[];
  routing: ChangeRequestPreview[];
  slackPreview: string;
  notes: string[];
}
