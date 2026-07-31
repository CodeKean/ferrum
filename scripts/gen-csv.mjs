// Synthetic lead CSV generator, for benchmarking the import and window-read paths at real scale.
//   node scripts/gen-csv.mjs <rows> <outPath>
//
// Deliberately includes the awkward cases the importer has to survive: a non-ASCII company name, a
// value that Excel would execute as a formula, and an empty field.

import { createWriteStream } from "node:fs";

const rows = Number(process.argv[2] ?? 1_000_000);
const out = process.argv[3] ?? "bench.csv";

const words = ["Apex", "Northwind", "Vertex", "Lumen", "Cobalt", "Harbor", "Quill", "Meridian", "Onyx", "Cedar", "Atlas", "Juniper"];
const suffix = ["Labs", "Group", "Systems", "Partners", "Digital", "Works", "Technologies"];
const countries = ["US", "UK", "CA", "DE", "FR", "AU", "NL", "ES"];
const industries = ["SaaS", "Fintech", "Healthcare", "Logistics", "Retail", "Manufacturing", "Agency"];

const ws = createWriteStream(out);
ws.write("Company,Website,Employees,Country,Industry,Contact Email\n");

let buf = "";
for (let i = 0; i < rows; i++) {
  // Deterministic pseudo-variety without Math.random, so a rerun produces an identical file.
  const a = words[i % words.length];
  const b = suffix[(i >> 3) % suffix.length];
  const n = (i % 4900) + 3;
  const country = countries[(i >> 1) % countries.length];
  const industry = industries[(i >> 2) % industries.length];

  // Every 5000th row exercises a specific hazard.
  let company = `${a} ${b} ${i}`;
  if (i % 5000 === 1) company = `Café Ünïcode ${i}`;      // cp1252 / UTF-8 round-trip
  if (i % 5000 === 2) company = `=cmd|'/c calc'!A0 ${i}`;  // formula injection on export

  const slug = `${a}${b}${i}`.toLowerCase();
  const website = i % 97 === 0 ? "" : `https://${slug}.com`; // some rows genuinely have no website
  const email = i % 53 === 0 ? "" : `ops@${slug}.com`;

  buf += `"${company}",${website},${n},${country},${industry},${email}\n`;

  if (buf.length > 1 << 20) {
    if (!ws.write(buf)) await new Promise((r) => ws.once("drain", r));
    buf = "";
  }
}
if (buf) ws.write(buf);
ws.end();
await new Promise((r) => ws.once("finish", r));
console.log(`wrote ${rows.toLocaleString()} rows -> ${out}`);
