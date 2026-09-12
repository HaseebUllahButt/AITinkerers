export const DEFAULT_TOOLS = [
  { name: "imagineart", aliases: ["imagine.art", "ImagineArt"] },
  { name: "kling", aliases: ["Kling AI", "Kuaishou"] },
  { name: "seedance", aliases: ["Seedance"] },
  { name: "runway", aliases: ["Runway ML", "RunwayML"] },
  { name: "pika", aliases: ["Pika Labs", "Pika Art"] },
  { name: "sora", aliases: ["OpenAI Sora"] },
  { name: "midjourney", aliases: ["MJ", "Mid Journey"] },
  { name: "ideogram", aliases: ["Ideogram AI"] },
  { name: "luma", aliases: ["Luma AI", "Dream Machine", "LumaLabs"] },
  { name: "higgsfield", aliases: ["Higgsfield AI"] },
  { name: "hailuo", aliases: ["MiniMax Video", "Hailuo AI"] },
  { name: "veo", aliases: ["Google Veo", "Veo 2", "Veo 3"] },
  { name: "flux", aliases: ["FLUX", "Black Forest Labs", "FLUX.1"] },
  { name: "heygen", aliases: ["HeyGen AI"] },
  { name: "nanobanana", aliases: ["Nano Banana"] },
  { name: "invideo", aliases: ["InVideo AI"] },
  { name: "krea", aliases: ["Krea AI"] },
  { name: "adobe firefly", aliases: ["Adobe Firefly", "Firefly"] },
  { name: "canva ai", aliases: ["Canva Magic", "Canva AI"] },
  { name: "leonardo", aliases: ["Leonardo AI", "Leonardo.Ai"] },
];

export const ARCHETYPE_QUERIES = (tool: string) => [
  `best ai video generator ${tool}`,
  `top ai image tools ${tool}`,
  `best ${tool} alternatives`,
  `${tool} vs`,
  `${tool} review`,
  `${tool} alternative`,
  `we tested ${tool}`,
  `generative ai tools roundup ${tool}`,
  `ai design tools 2025 ${tool}`,
  `ai tools comparison ${tool}`,
];

// Publications the RSS/sitemap + WordPress harvesters mine for author bylines. A discovery
// run rotates through a bounded window of these each time (see run.ts) so the whole list is
// covered over successive runs without blowing the serverless time budget. Kept broad and
// diverse on purpose — the scoring stage filters for relevance, so breadth here = more new
// writers. Add freely; keep entries as bare hostnames (no scheme/path), deduped.
export const SEED_DOMAINS = [
  // Big tech / AI news
  "techcrunch.com", "theverge.com", "wired.com", "venturebeat.com", "arstechnica.com",
  "thenextweb.com", "zdnet.com", "futurism.com", "engadget.com", "gizmodo.com",
  "mashable.com", "techradar.com", "readwrite.com", "siliconangle.com", "axios.com",
  "fastcompany.com", "forbes.com", "inc.com", "businessinsider.com", "theregister.com",
  "techspot.com", "pcworld.com", "slashgear.com", "thenewstack.io", "infoworld.com",

  // AI-native news, newsletters & blogs
  "therundown.ai", "bensbites.co", "superhuman.ai", "aitoolreport.beehiiv.com", "aiweekly.co",
  "alphasignal.ai", "unite.ai", "marktechpost.com", "syncedreview.com", "dataconomy.com",
  "the-decoder.com", "aibusiness.com", "emerj.com", "kdnuggets.com", "thegradient.pub",
  "analyticsindiamag.com", "decrypt.co", "maginative.com", "aituts.com", "80.lv",
  "oneusefulthing.org", "platformer.news", "lastweekin.ai", "aisupremacy.substack.com", "thealgorithmicbridge.substack.com",

  // Marketing / advertising / martech / social (creative-tool buyers)
  "marketingdive.com", "adage.com", "adweek.com", "thedrum.com", "martech.org",
  "searchenginejournal.com", "searchengineland.com", "contentmarketinginstitute.com", "socialmediaexaminer.com", "socialmediatoday.com",
  "digiday.com", "marketingprofs.com", "cmswire.com", "econsultancy.com", "wordstream.com",
  "buffer.com", "later.com", "sproutsocial.com", "neilpatel.com", "copyblogger.com",
  "hubspot.com", "semrush.com", "ahrefs.com", "backlinko.com", "convinceandconvert.com",

  // Creative / design
  "creativebloq.com", "designboom.com", "creativepro.com", "itsnicethat.com", "abduzeedo.com",
  "smashingmagazine.com", "designmodo.com", "webdesignerdepot.com", "core77.com", "printmag.com",
  "artstation.com", "renderguide.com", "thedieline.com", "designweek.co.uk",

  // Film / video / VFX / motion
  "provideocoalition.com", "nofilmschool.com", "videomaker.com", "fxguide.com", "befores-afters.com",
  "premiumbeat.com", "motionarray.com", "shutterstock.com", "rocketstock.com",

  // Photography
  "petapixel.com", "dpreview.com", "photofocus.com", "fstoppers.com", "diyphotography.net",
  "digital-photography-school.com", "slrlounge.com", "thephoblographer.com", "shotkit.com", "digitalcameraworld.com",
  "imaging-resource.com", "photographylife.com",

  // Developer / ML community
  "towardsdatascience.com", "analyticsvidhya.com", "hackernoon.com", "dev.to", "huggingface.co",
  "paperswithcode.com", "machinelearningmastery.com", "freecodecamp.org",

  // Consumer tech & how-to
  "makeuseof.com", "howtogeek.com", "lifewire.com", "cnet.com", "digitaltrends.com",
  "pcmag.com", "tomsguide.com", "tomshardware.com", "androidpolice.com", "xda-developers.com",
  "9to5mac.com", "9to5google.com",

  // Regional / international tech
  "yourstory.com", "inc42.com", "techinasia.com", "gadgets360.com", "livemint.com",
  "restofworld.org",

  // Company / tool blogs
  "nvidia.com", "blogs.microsoft.com", "stability.ai", "openai.com",
];

export const RELEVANT_SUBREDDITS = [
  "StableDiffusion", "aivideo", "artificial", "midjourney", "AIAssistants",
  "singularity", "MediaSynthesis", "AIart", "ChatGPT", "MachineLearning",
  "generative", "aiArt", "comfyui", "runwayml", "SoraAI",
  "OpenAI", "LocalLLaMA", "StableDiffusionInfo", "editors", "VideoEditing",
  "graphic_design", "marketing", "content_marketing", "socialmedia", "Filmmakers",
];
