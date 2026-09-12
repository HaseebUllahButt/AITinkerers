import type { RawHit } from "@/lib/types";

export type HarvesterName = "rss" | "gdelt" | "hackernews" | "reddit" | "wordpress" | "ghost" | "commoncrawl" | "wayback" | "brave";

export interface Harvester {
  name: HarvesterName;
  run(query: string, opts?: Record<string, unknown>): Promise<RawHit[]>;
}

export { rssHarvester } from "./rss";
export { gdeltHarvester } from "./gdelt";
export { hnHarvester } from "./hackernews";
export { redditHarvester } from "./reddit";
export { wordpressHarvester } from "./wordpress";
export { ghostHarvester } from "./ghost";
export { commonCrawlHarvester } from "./commoncrawl";
export { waybackHarvester } from "./wayback";
export { braveHarvester } from "./brave";
