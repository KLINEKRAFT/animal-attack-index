export async function onRequest(context) {
  const { env } = context;
  const GK = env.GUARDIAN_API_KEY;
  const NK = env.NEWSDATA_API_KEY;
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=900" };

  const articles = [];
  const seen = new Set();

  // ─── RELEVANCE SCORING ───
  // Title matches worth 3 pts, description matches worth 1 pt
  // Must score >= 3 to pass (i.e. animal word must appear in title, or multiple in desc)
  const ANIMAL_TITLE = [
    "shark", "bear", "dog attack", "dog mauling", "dog bite", "mauled by dog",
    "wolf", "coyote", "lion attack", "tiger attack", "tiger kill", "leopard",
    "cougar", "panther", "puma", "mountain lion",
    "crocodile", "alligator", "croc attack",
    "snake bite", "snakebite", "cobra", "viper", "python", "rattlesnake", "mamba",
    "hippo", "hippopotamus", "elephant attack", "elephant trampl",
    "rhino", "bison", "buffalo attack", "moose attack",
    "wild boar", "feral pig", "feral hog",
    "monkey attack", "baboon", "chimpanzee",
    "jellyfish", "stingray",
    "bee sting", "bee attack", "wasp attack", "hornet",
    "spider bite", "scorpion",
    "hyena", "jaguar", "dingo", "cassowary", "komodo",
    "animal attack", "wildlife attack",
    "mauled by", "bitten by", "gored by", "trampled by",
    "killed by animal", "killed by bear", "killed by shark", "killed by tiger",
    "killed by lion", "killed by elephant", "killed by crocodile", "killed by snake",
    "animal kills", "animal mauls",
    "fatal bite", "fatal attack",
  ];

  const REJECT = [
    // Politics & military
    "putin", "trump", "biden", "harris", "election", "parliament", "congress",
    "missile", "airstrike", "bombing", "nato", "ukraine war", "gaza", "houthi",
    "sanctions", "tariff", "trade war", "diplomatic",
    // Sports
    "nba", "nfl", "premier league", "champions league", "world cup", "olympics",
    "touchdown", "goalkeeper", "quarterback", "tennis", "golf tournament",
    "masters", "augusta", "grand slam", "cricket match", "rugby",
    "vols ", "wolverine", "bulldogs", "tigers win", "bears win", "sharks win",
    "wildcats", "mustangs", "final four", "march madness", "ncaa",
    // Food & lifestyle
    "recipe", "restaurant", "cookbook", "ice cream", "dessert", "cocktail",
    "fashion", "stylist", "wardrobe", "makeup", "skincare",
    "poetry", "bedtime", "meditation", "yoga class",
    // Entertainment
    "movie review", "film review", "album review", "box office",
    "netflix", "disney", "marvel", "tv show", "streaming",
    "forgotten food", "forgotten movie", "forgotten commercial",
    "best-reviewed shark movie", "jaws ", "hulu",
    // Tech/cyber
    "cyber attack", "ransomware", "data breach", "hack ",
    // Medical false positives
    "heart attack", "panic attack", "anxiety attack", "asthma attack",
    // Business
    "stock market", "cryptocurrency", "bitcoin", "nasdaq",
    // Postal / misc
    "royal mail", "post office", "suspended post", "postal worker",
    "sperm whale", "whale watching", "conservation effort",
    "exercise", "workout", "influencer",
  ];

  function scoreArticle(title, desc) {
    const t = (title || "").toLowerCase();
    const d = (desc || "").toLowerCase();
    const full = t + " " + d;

    // Hard reject
    for (const r of REJECT) {
      if (full.includes(r)) return -1;
    }

    let score = 0;
    // Title matches = 3 pts each
    for (const w of ANIMAL_TITLE) {
      if (t.includes(w)) { score += 3; break; } // only count once for title
    }
    // Desc matches = 1 pt each (up to 2)
    let descHits = 0;
    for (const w of ANIMAL_TITLE) {
      if (d.includes(w) && descHits < 2) { score += 1; descHits++; }
    }
    return score;
  }

  function addArticle(a) {
    const key = (a.title || "").toLowerCase().trim().slice(0, 60);
    if (!key || seen.has(key)) return;
    const score = scoreArticle(a.title, a.description);
    if (score < 3) return;
    seen.add(key);
    articles.push(a);
  }

  const now = new Date();
  const from = new Date(now.getTime() - 90 * 86400000);
  const fromDate = from.toISOString().split("T")[0];

  // ─── Guardian ───
  const gQ = [
    '"shark attack"', '"bear attack"', '"bear mauling"',
    '"crocodile attack"', '"alligator attack"',
    '"dog attack" OR "dog mauling"',
    '"snake bite" OR "snakebite"',
    '"lion attack" OR "tiger attack"',
    '"elephant attack" OR "elephant trampling"',
    '"hippo attack"', '"wolf attack"',
    '"animal attack"', '"mauled by"',
    '"bitten by" AND animal', '"gored by"',
  ];

  for (const q of gQ) {
    try {
      const r = await fetch(`https://content.guardianapis.com/search?q=${encodeURIComponent(q)}&from-date=${fromDate}&page-size=10&order-by=newest&show-fields=trailText,thumbnail&api-key=${GK}`);
      const d = await r.json();
      if (d.response?.results) {
        for (const x of d.response.results) {
          addArticle({ title: x.webTitle || "", description: x.fields?.trailText || "", url: x.webUrl || "", publishedAt: x.webPublicationDate || "", source: "The Guardian" });
        }
      }
    } catch (e) {}
  }

  // ─── Newsdata ───
  const nQ = ['"animal attack"', '"shark attack"', '"bear attack"', '"crocodile attack"', '"snake bite"', '"dog attack"', '"mauled by"'];

  for (const q of nQ) {
    try {
      const r = await fetch(`https://newsdata.io/api/1/news?apikey=${NK}&q=${encodeURIComponent(q)}&language=en&size=10`);
      const d = await r.json();
      if (d.results) {
        for (const x of d.results) {
          addArticle({ title: x.title || "", description: x.description || "", url: x.link || "", publishedAt: x.pubDate || "", source: x.source_id || "Newsdata" });
        }
      }
    } catch (e) {}
  }

  articles.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

  return new Response(JSON.stringify({
    articles,
    meta: { sources_label: "The Guardian + Newsdata.io", count: articles.length, date_range: fromDate + " to " + now.toISOString().split("T")[0] }
  }), { status: 200, headers });
}
