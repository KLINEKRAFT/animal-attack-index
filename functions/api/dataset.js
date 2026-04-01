// functions/api/dataset.js
// Reads one chunk at a time from R2 (10 chunks of ~105K rows each)
// Frontend specifies chunk via ?chunk=N (1-10, default 1)
// Each chunk is ~21MB — safely under 128MB Worker memory limit
//
// Query params:
//   ?chunk=1              — which chunk to read (1-10, default 1)
//   ?animal=SHARK         — filter by animal_common
//   ?fatal=true           — filter fatal only
//   ?country=USA          — filter by country
//   ?state=Florida        — filter by state_region
//   ?year_from=2020       — min year
//   ?year_to=2025         — max year
//   ?limit=30             — results per page (default 30, max 200)
//   ?offset=0             — pagination offset within this chunk
//   ?stats=true           — return aggregate stats (scans full chunk)

const TOTAL_CHUNKS = 10;
const ROWS_PER_CHUNK = 105000;

export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const params = url.searchParams;

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=300",
  };

  try {
    const chunkNum = Math.min(Math.max(parseInt(params.get("chunk") || "1"), 1), TOTAL_CHUNKS);
    const filename = `dataset_chunk_${chunkNum}.csv`;

    const obj = await env.DATASET_BUCKET.get(filename);
    if (!obj) throw new Error(`Chunk ${chunkNum} not found: ${filename}`);

    const text = await obj.text();
    const lines = text.split("\n");
    if (lines.length < 2) throw new Error("Empty chunk");

    // Parse header
    const hdr = lines[0].split(",").map(h => h.trim().replace(/"/g, ""));
    const ci = {};
    hdr.forEach((h, i) => ci[h] = i);

    // Filters
    const fAnimal = (params.get("animal") || "").toUpperCase();
    const fFatal = params.get("fatal") === "true";
    const fCountry = (params.get("country") || "").toUpperCase();
    const fState = (params.get("state") || "").toLowerCase();
    const fYearFrom = params.get("year_from") ? parseInt(params.get("year_from")) : null;
    const fYearTo = params.get("year_to") ? parseInt(params.get("year_to")) : null;
    const statsMode = params.get("stats") === "true";
    const limit = Math.min(parseInt(params.get("limit") || "30"), 200);
    const offset = parseInt(params.get("offset") || "0");

    function splitLine(line) {
      const fields = [];
      let cur = "", inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line.charCodeAt(i);
        if (inQ) {
          if (ch === 34) {
            if (i + 1 < line.length && line.charCodeAt(i + 1) === 34) { cur += '"'; i++; }
            else inQ = false;
          } else cur += line[i];
        } else {
          if (ch === 34) inQ = true;
          else if (ch === 44) { fields.push(cur); cur = ""; }
          else cur += line[i];
        }
      }
      fields.push(cur);
      return fields;
    }

    let matchCount = 0;
    const results = [];
    let statFatal = 0, statInj = 0, statDeath = 0;
    const animalCt = {}, countryCt = {};

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.length < 5) continue;

      const fields = splitLine(line);
      const getF = (name) => (fields[ci[name]] || "").trim();

      // Apply filters
      if (fAnimal && fAnimal !== "ALL" && !getF("animal_common").toUpperCase().includes(fAnimal)) continue;
      if (fFatal && getF("fatal") !== "Yes") continue;
      if (fCountry && getF("country").toUpperCase() !== fCountry) continue;
      if (fState && !getF("state_region").toLowerCase().includes(fState)) continue;
      if (fYearFrom !== null && parseInt(getF("year")) < fYearFrom) continue;
      if (fYearTo !== null && parseInt(getF("year")) > fYearTo) continue;

      matchCount++;

      if (statsMode) {
        if (getF("fatal") === "Yes") statFatal++;
        statInj += parseInt(getF("injuries")) || 0;
        statDeath += parseInt(getF("deaths")) || 0;
        const animal = getF("animal_common");
        const country = getF("country");
        animalCt[animal] = (animalCt[animal] || 0) + 1;
        countryCt[country] = (countryCt[country] || 0) + 1;
      } else {
        if (matchCount > offset && results.length < limit) {
          const row = {};
          hdr.forEach((h, idx) => { row[h] = (fields[idx] || "").trim(); });
          results.push(row);
        }
      }
    }

    if (statsMode) {
      return new Response(JSON.stringify({
        chunk: chunkNum,
        total_chunks: TOTAL_CHUNKS,
        total: matchCount,
        fatal: statFatal,
        injuries: statInj,
        deaths: statDeath,
        top_animals: Object.entries(animalCt).sort((a, b) => b[1] - a[1]).slice(0, 15),
        top_countries: Object.entries(countryCt).sort((a, b) => b[1] - a[1]).slice(0, 15),
      }), { headers });
    }

    return new Response(JSON.stringify({
      chunk: chunkNum,
      total_chunks: TOTAL_CHUNKS,
      chunk_matches: matchCount,
      limit,
      offset,
      rows: results,
    }), { headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
