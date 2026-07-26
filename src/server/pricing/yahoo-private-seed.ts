import type { YahooPrivateCompanyQuote } from "./yahoo-private-client.js";

type SeedRow = [
  ticker: string,
  priceUsd: number,
  companyName: string,
  valuation: string,
  latestFundingDate: string | null,
  latestShareClass: string | null,
  sector: string | null
];

// Snapshot captured from Yahoo Finance's Highest Valuation Private Companies
// table on 2026-07-26. It is used only when Yahoo's live endpoint and cache are
// unavailable, and is always labelled stale in API responses.
const rows: SeedRow[] = [
  [
    "ANTH.PVT",
    589.01,
    "Anthropic",
    "965.001B",
    "2026-05-27",
    "Series H-1",
    "Artificial Intelligence"
  ],
  [
    "OPAI.PVT",
    721.85,
    "OpenAI",
    "894.326B",
    "2026-03-30",
    "Series C-NV",
    "Artificial Intelligence"
  ],
  ["STRI.PVT", 72.45, "Stripe", "184.401B", "2026-02-23", "Tender Offer 3", "Financial Services"],
  ["DATB.PVT", 242.04, "Databricks", "170.702B", "2026-02-08", "Series L", "Data and Analytics"],
  [
    "ANIN.PVT",
    140,
    "Anduril Industries",
    "123.858B",
    "2026-05-12",
    "Series H",
    "Government and Military"
  ],
  ["RAMP.PVT", 125.55, "Ramp", "46.035B", "2026-06-03", "Series F", "Financial Services"],
  ["CUES.PVT", 224.54, "Crusoe", "26.728B", "2025-10-23", "Series E", "Energy"],
  ["KLSH.PVT", 604.86, "Kalshi", "22B", "2026-03-18", "Series F", "Financial Services"],
  [
    "PEAI.PVT",
    65.88,
    "Perplexity",
    "19.318B",
    "2025-09-25",
    "Series E-6",
    "Artificial Intelligence"
  ],
  ["RIPP.PVT", 55, "Rippling", "17.77B", "2025-05-08", "Tender Offer 1", "Administrative Services"],
  [
    "RIPL.PVT",
    106.89,
    "Ripple",
    "17.578B",
    "2026-03-10",
    "Tender Offer 1",
    "Blockchain and Crypto"
  ],
  [
    "FANA.PVT",
    42,
    "Fanatics",
    "17.093B",
    "2022-12-05",
    "Private Equity Round 3",
    "Commerce and Shopping"
  ],
  ["NEUR.PVT", 75.62, "Neuralink", "14.865B", "2025-06-01", "Series E", "Biotechnology"],
  ["SKIA.PVT", 66.37, "Skild AI", "14.305B", "2026-01-13", "Series C", "Hardware"],
  ["SAAQ.PVT", 41.35, "SandboxAQ", "13.888B", "2026-05-20", "Series F", "Privacy and Security"],
  ["SHAI.PVT", 165.98, "Shield AI", "13.716B", "2026-03-25", "Series G", "Government and Military"],
  ["POLA.PVT", 136.55, "Polymarket", "13.467B", "2026-03-25", "Series E", "Blockchain and Crypto"],
  [
    "EPGA.PVT",
    331.33,
    "Epic Games",
    "12.425B",
    "2024-02-07",
    "Corporate Round",
    "Media and Entertainment"
  ],
  ["ZIPL.PVT", 81.7, "Zipline", "11.326B", "2026-03-22", "Series H", "Supply Chain and Logistics"],
  ["REPI.PVT", 259.43, "Replit", "9.405B", "2026-03-10", "Series D", "Software"],
  ["KRAK.PVT", 28.57, "Kraken", "9.296B", "2025-11-17", "Series D", "Blockchain and Crypto"],
  [
    "DISO.PVT",
    31.31,
    "Discord",
    "8.529B",
    "2021-08-14",
    "Series I",
    "Messaging and Telecommunications"
  ],
  ["NETS.PVT", 22.49, "Netskope", "8.249B", "2021-07-08", "Series H", "Privacy and Security"],
  ["VERC.PVT", 175.01, "Vercel", "8.104B", "2025-09-29", "Tender Offer 1", "Software"],
  ["LAMD.PVT", 42.06, "Lambda", "7.689B", "2025-11-17", "Series E-3", "Data and Analytics"],
  ["SANS.PVT", 85, "SambaNova", "7.356B", "2026-07-07", "Series F Non-Voting", "Hardware"],
  ["WHOO.PVT", 7.3, "WHOOP", "6.563B", "2026-03-30", "Series G-2", "Consumer Goods"],
  ["GLEA.PVT", 44.43, "Glean", "6.526B", "2025-06-09", "Series F", "Data and Analytics"],
  ["ABRI.PVT", 170.2, "Abridge", "5.692B", "2025-06-23", "Series E", "Software"],
  ["VERK.PVT", 10.5, "Verkada", "5.66B", "2025-11-04", "Series F", "Privacy and Security"],
  ["LIG.PVT", 96.52, "Lightmatter", "5.293B", "2024-10-15", "Series C-3", "Hardware"],
  ["UPGR.PVT", 3.25, "Upgrade", "5.048B", "2025-11-30", "Tender Offer 1", "Financial Services"],
  ["MERC.PVT", 17, "Mercury", "4.988B", "2026-05-19", "Series D", "Financial Services"],
  ["PSIQ.PVT", 28.54, "PsiQuantum", "4.858B", "2025-09-09", "Series E", "Hardware"],
  ["COHS.PVT", 15.67, "Cohesity", "4.69B", "2024-12-09", "Series H-1", "Data and Analytics"],
  ["REMA.PVT", 36.37, "Redwood Materials", "4.601B", "2025-10-22", "Series E", "Energy"],
  ["CRIB.PVT", 4.86, "Cribl", "4.405B", "2024-08-26", "Series E", "Data and Analytics"],
  ["BREX.PVT", 12.23, "Brex", "4.331B", "2022-01-10", "Series D-2", "Financial Services"],
  ["ARWO.PVT", 8, "Arctic Wolf", "4.21B", "2021-07-12", "Series F", "Privacy and Security"],
  ["THFD.PVT", 26.25, "The Farmer's Dog", "4.174B", "2022-06-07", "Series E", "Consumer Goods"],
  ["HARN.PVT", 19, "Harness", "4.116B", "2025-12-10", "Tender Offer 1", "Software"],
  ["NURO.PVT", 8.5, "Nuro", "3.986B", "2025-08-20", "Series E", "Transportation"],
  ["TANI.PVT", 4.71, "Tanium", "3.72B", "2020-06-24", "Series H", "Privacy and Security"],
  ["DITD.PVT", 42.26, "Divergent 3D", "3.373B", "2026-07-16", "Series F-1", "Manufacturing"],
  ["ALCH.PVT", 170.2, "Alchemy", "3.367B", null, null, null],
  ["AIR.PVT", 46.65, "Airtable", "2.923B", "2021-12-12", "Series F", "Software"],
  ["STOS.PVT", 40, "Stoke Space", "2.74B", "2026-02-09", "Series D-2", "Science and Engineering"],
  ["TATE.PVT", 45, "TAE Technologies", "2.472B", "2025-06-01", "Series 12", "Energy"],
  ["WORA.PVT", 6.78, "Workato", "2.39B", "2021-11-09", "Series E", "Software"],
  ["ADDE.PVT", 2.55, "Addepar", "2.328B", "2025-05-12", "Series G", "Financial Services"],
  ["SINA.PVT", 16.42, "Sila Nanotechnologies", "2.328B", "2026-07-20", "Series H", "Energy"],
  ["AGRO.PVT", 71, "Agility Robotics", "2.279B", "2025-06-24", "Series C-3", "Hardware"],
  [
    "MOTV.PVT",
    17.17,
    "Motive",
    "2.26B",
    "2025-07-29",
    "Series F Senior",
    "Supply Chain and Logistics"
  ],
  ["POSM.PVT", 7, "Postman", "2.224B", "2021-08-17", "Series D", "Software"],
  ["STRV.PVT", 13.99, "Strava", "2.2B", "2025-05-21", "Series F-1", "Apps"],
  ["INTC.PVT", 51.03, "Intercom", "2.021B", "2018-03-16", "Series D", "Sales and Marketing"],
  ["RAPP.PVT", 20, "Rappi", "1.664B", "2022-09-14", "Series F", "Transportation"],
  ["CONS.PVT", 29.94, "Consensys", "1.511B", "2022-03-14", "Series D", "Blockchain and Crypto"],
  [
    "AUAN.PVT",
    3.6,
    "Automation Anywhere",
    "1.474B",
    "2019-11-20",
    "Series B",
    "Data and Analytics"
  ],
  ["CHAA.PVT", 6.2, "Chainalysis", "1.323B", "2022-05-11", "Series F", "Privacy and Security"],
  ["INNA.PVT", 2.62, "Innovaccer", "1.223B", "2025-01-08", "Series F-1", "Health Care"],
  ["CIHE.PVT", 15.38, "Cityblock Health", "1.217B", "2024-06-17", "Series X", "Health Care"],
  ["GERO.PVT", 45.99, "Gecko Robotics", "1.167B", "2025-06-11", "Series D-1", "Hardware"],
  ["TURO.PVT", 8.65, "Turo", "1.103B", "2024-09-29", "Series 1", "Transportation"],
  ["NEFJ.PVT", 6.1, "Neo4j", "1.091B", "2021-11-08", "Series F", "Data and Analytics"],
  ["EISL.PVT", 5.76, "Eight Sleep", "1.076B", "2026-03-03", "Series D", "Consumer Electronics"],
  ["THMA.PVT", 20, "Thrive Market", "1.045B", "2021-07-07", "Series C", "Food and Beverage"],
  ["EPIR.PVT", 2.79, "Epirus", "1.007B", "2025-03-03", "Series D", "Government and Military"],
  ["LOOR.PVT", 24.77, "Loft Orbital", "954.47M", "2025-01-13", "Series C", "Space"],
  ["ATTE.PVT", 6.03, "Attentive", "913.457M", "2021-03-23", "Series E", "Sales and Marketing"],
  [
    "FLEP.PVT",
    3.25,
    "Flexport",
    "913.204M",
    "2022-02-06",
    "Series E",
    "Supply Chain and Logistics"
  ],
  ["LIDE.PVT", 7.67, "Liquid Death", "834.072M", "2024-03-10", "Series F-1", "Food and Beverage"],
  ["CRES.PVT", 5.03, "Cresta", "833.097M", "2024-11-18", "Series D", "Software"],
  ["INSA.PVT", 3.97, "Instabase", "801.783M", "2025-01-16", "Series D", "Data and Analytics"],
  ["DRAG.PVT", 20, "Dragos", "798.919M", "2023-09-17", "Series D", "Privacy and Security"],
  ["VECR.PVT", 4.96, "Vectra AI", "782.969M", "2021-04-28", "Series F", "Privacy and Security"],
  ["DIAL.PVT", 3.98, "Dialpad", "756.673M", null, null, null],
  ["PATR.PVT", 8.83, "Patreon", "706.18M", "2021-04-05", "Series F", "Media and Entertainment"],
  ["FLOQ.PVT", 7.29, "FloQast", "704.286M", "2024-04-09", "Series E", "Software"],
  ["DTMR.PVT", 7.5, "Dataminr", "698.938M", "2021-03-22", "Series F", "Software"],
  ["GREE.PVT", 15.76, "Greenlight", "600.95M", "2021-04-26", "Series D", "Financial Services"],
  ["ENRX.PVT", 5.67, "EnergyX", "571.512M", "2023-06-29", "Series B", "Energy"],
  ["THSP.PVT", 3.2, "ThoughtSpot", "556.213M", "2023-07-17", "Series F-1", "Software"],
  ["APOL.PVT", 7.57, "Apollo.io", "547.018M", "2023-08-28", "Series D", "Sales and Marketing"],
  ["SIXS.PVT", 3.25, "6sense", "534.437M", "2022-01-19", "Series E-1", "Software"],
  ["BIGI.PVT", 1.93, "BigID", "531.534M", "2024-03-17", "Series E", "Privacy and Security"],
  ["WORR.PVT", 75, "Workrise", "518.946M", "2021-05-19", "Series E", "Administrative Services"],
  ["ZOCD.PVT", 5, "Zocdoc", "446.48M", "2021-02-10", "Series D-2", "Health Care"],
  [
    "IMPF.PVT",
    1.51,
    "Impossible Foods",
    "427.352M",
    "2021-11-22",
    "Series H-1",
    "Food and Beverage"
  ],
  ["AVIA.PVT", 3.48, "Aviatrix", "411.025M", "2021-09-07", "Series E", "Data and Analytics"],
  ["TEAL.PVT", 4.79, "Tealium", "401.222M", null, null, null],
  ["PLEN.PVT", 0.22, "Plenty", "398.037M", null, null, null],
  ["COLH.PVT", 0.18, "Collective Health", "366.863M", "2021-05-03", "Series F", "Health Care"],
  ["STDA.PVT", 0.59, "Starburst Data", "343.868M", "2022-02-08", "Series D", "Data and Analytics"],
  ["AVTN.PVT", 3.6, "Avathon", "323.218M", "2022-01-24", "Series D", "Artificial Intelligence"],
  ["BLOO.PVT", 3.99, "Bloomreach", "323.023M", "2022-02-22", "Series F", "Sales and Marketing"],
  ["ACOR.PVT", 2, "Acorns", "311.6M", "2023-03-30", "Series G-E", "Financial Services"],
  ["SIST.PVT", 1.51, "SingleStore", "310.482M", "2022-07-11", "Series F-2", "Data and Analytics"],
  ["LEOL.PVT", 2.8, "LeoLabs", "302.687M", "2024-02-11", "Series B", "Space"],
  ["OUTR.PVT", 1.98, "Outreach", "300.152M", "2021-05-26", "Series G", "Software"],
  ["NEWS.PVT", 5.84, "Newsela", "297.125M", "2021-02-24", "Series D", "Education"],
  ["KORE.PVT", 5.15, "Kore.ai", "287.719M", "2024-01-29", "Series D", "Software"],
  ["DATO.PVT", 0.72, "DataRobot", "169.773M", "2021-07-26", "Series G", "Data and Analytics"],
  ["STAA.PVT", 26.06, "Stability AI", "150.181M", null, null, null],
  ["HTWO.PVT", 2.29, "H2O.ai", "136.009M", "2021-11-06", "Series E", "Software"],
  ["NEXO.PVT", 1.68, "NextRoll", "85.844M", null, null, null],
  ["TUTE.PVT", 0.32, "Turntide Technologies", "76.372M", null, null, null]
];

function valuationUsd(value: string): number {
  const suffix = value.at(-1);
  const multiplier = suffix === "B" ? 1_000_000_000 : suffix === "M" ? 1_000_000 : 1;
  return Number.parseFloat(multiplier === 1 ? value : value.slice(0, -1)) * multiplier;
}

export function yahooPrivateSeed(
  fetchedAt = Math.floor(Date.parse("2026-07-26T01:20:00Z") / 1000)
): YahooPrivateCompanyQuote[] {
  return rows.map(
    ([ticker, priceUsd, companyName, valuation, latestFundingDate, latestShareClass, sector]) => ({
      ticker,
      companyName,
      priceUsd,
      estimatedValuationUsd: valuationUsd(valuation),
      latestFundingDate,
      latestShareClass,
      sector,
      fetchedAt,
      sourceUrl: "https://finance.yahoo.com/markets/private-companies/highest-valuation/",
      cacheStatus: "stale"
    })
  );
}
