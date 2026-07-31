// The lanes a column can be filled by, as data.
//
// Split out of `ModePicker.tsx` so it can be tested. The component imports its own stylesheet, and a
// test importing the component pulls the CSS in with it and dies on the file extension — so the
// thing worth pinning (which words find which lane) was untestable purely because it lived next to
// a `import "./ModePicker.css"`.
//
// Nothing here renders. It is the catalogue plus the search over it.
/** The lanes the engine can execute today. */
export type Mode = "static" | "script" | "ai" | "agent" | "http" | "mcp" | "send" | "lookup" | "rollup" | "waterfall" | "wait";

export interface ModeSpec {
  /** Card id — distinct from the lane, because two cards share the http lane. */
  id: string;
  mode: Mode;
  title: string;
  /**
   * The industry name for this lane, shown beside the title.
   *
   * The titles here are deliberately plain English, because the person choosing usually does not
   * know what an HTTP request is and should not have to. But that made the whole screen unsearchable
   * for the person who DOES: someone arriving from Clay looks for "HTTP API", "webhook", "lookup" or
   * "rollup", and not one of those words appeared anywhere on this screen. Both readers exist, often
   * on the same team, so both names are on the card.
   */
  tag: string;
  /**
   * Everything else someone might type looking for this lane — other tools' names for it, the
   * providers it is used with, the verb they have in mind.
   *
   * Never rendered. It exists so that searching "vlookup", "zapier", "aggregate" or "gpt" lands on
   * the right card rather than on nothing, which is the outcome that sends someone to look for the
   * feature in a competitor instead.
   */
  keywords: string;
  /** The question that decides it, phrased so it can be answered without knowing how any of it works. */
  test: string;
  detail: string;
  example: string;
  /**
   * Applied when this card is picked.
   *
   * "Call an API" and "Send it somewhere" are the SAME lane with one setting different — whether the
   * reply is kept. Two cards rather than one card plus a buried toggle, because they are different
   * jobs to the person choosing, and the picker's whole purpose is to be readable by that person.
   */
  httpPreset?: { fireAndForget: boolean };
}

export const MODES: ModeSpec[] = [
  {
    id: "static",
    mode: "static",
    title: "Typed in",
    tag: "Manual",
    keywords: "static fixed manual import csv paste upload plain text value blank",
    test: "The value comes from your import, or you type it yourself.",
    detail: "Nothing runs. The column holds whatever is in it.",
    example: "Company name, imported from a CSV",
  },
  {
    id: "script",
    mode: "script",
    title: "A rule",
    tag: "Formula",
    keywords:
      "script code formula javascript js python regex transform clean normalise normalize parse " +
      "split concat lowercase uppercase trim extract derive calculate expression function",
    test: "A careful person could fill this cell from the other columns without thinking about it.",
    detail:
      "You describe the rule once in plain English, a model writes the code once, and the code then " +
      "runs on every row. Re-running is free and gives the same answer every time.",
    example: "Root domain from Website · First and last name from Full name · Phone in E.164",
  },
  {
    id: "http-get",
    mode: "http",
    httpPreset: { fireAndForget: false },
    title: "Call an API",
    tag: "HTTP API",
    keywords:
      "http https api rest request endpoint url get post put patch header bearer token key auth " +
      "json query enrichment provider integration fetch call third party prospeo betterenrich " +
      "apollo clearbit hunter clay",
    test: "Another system already knows the answer and has a web address you can ask.",
    detail:
      "One request per row, with this row's values put into the address, headers or body. You choose " +
      "which field of the reply lands in the cell. Costs whatever that service charges — nothing here.",
    example: "Enrichment providers · Your own CRM · Anything with an API key",
  },
  {
    id: "http-send",
    mode: "http",
    httpPreset: { fireAndForget: true },
    title: "Send it somewhere",
    tag: "Webhook",
    keywords:
      "webhook post push notify fire forget outbound zapier make n8n slack discord teams pipedream " +
      "http api trigger automation send out",
    test: "You want to push each row out to another tool rather than fetch anything back.",
    detail:
      "The same request, but the cell records only whether it arrived. This is the shape for webhooks " +
      "— posting rows into Zapier, Make, n8n, Slack, or your own endpoint.",
    example: "Post new leads to a webhook · Notify a channel per row",
  },
  {
    id: "send",
    mode: "send",
    title: "Send it to another table",
    tag: "Write to table",
    keywords:
      "send write export push copy move rows another table crm upsert dedupe match explode expand " +
      "fan out flatten list into rows one per item write back",
    test: "These rows belong somewhere else in this workspace as well.",
    detail:
      "Each row here becomes a row over there — or, if this column holds a list, one row per item " +
      "in it. Matching on something like an email means sending again updates what is already " +
      "there instead of adding a second copy. Free, and it runs like any other column, so a run " +
      "condition decides which rows go.",
    example: "Qualified leads into a CRM table · A list of contacts exploded into a People table",
  },
  {
    id: "waterfall",
    mode: "waterfall",
    title: "Try one thing, then the next",
    tag: "Waterfall",
    keywords:
      "waterfall fallback cascade chain sequence try then else first second backup provider " +
      "enrichment email finder phone finder mobile clay prospeo betterenrich hunter apollo " +
      "dropcontact findymail leadmagic datagma verify verification coverage hit rate",
    // Phrased around the money, because that is the decision. Every other card describes what a lane
    // DOES; this one exists because running four providers on every row and running them until one
    // works are wildly different bills for the same result.
    test: "Several things could answer this, and you want the cheap ones asked first.",
    detail:
      "Put the steps in order — a free rule, then a cheap provider, then the expensive one — and " +
      "each runs only if the one before it did not settle the row. Every step says when to stop: " +
      "when it finds anything, when the answer LOOKS right (an actual email address, a real phone " +
      "number), or when the model is sure. A step can call any API, use a connected app, ask a " +
      "model, send an agent, run a rule or read another table, so this is the same feature whether " +
      "you are after emails, phones, company data or a second opinion from a better model.",
    example:
      "Guess the pattern free → Prospeo → Hunter, stopping at the first real address · " +
      "Local model → GPT only on the rows it was unsure about",
  },
  {
    id: "lookup",
    mode: "lookup",
    title: "Read it from another table",
    tag: "Lookup",
    keywords:
      "lookup vlookup xlookup join match relation reference link related foreign key bring back " +
      "pull from cross table connect merge enrich once",
    // The card that saves the most money in the product, so it is phrased around the waste it
    // avoids rather than around the mechanism. Someone comparing lanes is deciding what to SPEND.
    test: "The answer is already in another table in this workspace, next to a matching value.",
    detail:
      "Match each row to a row over there — usually on something like a domain or an email — and " +
      "bring a value back. Free, and it stays up to date: change the other table and the rows " +
      "reading it are marked out of date. Different spellings of the same thing still match, so " +
      "“https://www.Acme.com/” finds “acme.com”.",
    example:
      "2,000 contacts reading their company's industry — enrich the company ONCE instead of once " +
      "per contact",
  },
  {
    id: "rollup",
    mode: "rollup",
    title: "Count or total the other table",
    tag: "Rollup",
    keywords:
      "rollup roll up aggregate count sum total average avg mean min max largest smallest group by " +
      "join list concat how many number of subtotal",
    test: "You want one number about ALL the rows over there that point at this one.",
    detail:
      "How many, the total, the largest, the average, or the values joined into a list. Free, and " +
      "it keeps up: add a contact and the company's count goes out of date on its own. Values that " +
      "are not numbers are left out of a total rather than counted as zero, so one “unknown” cannot " +
      "quietly drag an average down.",
    example: "Contacts per company · Total pipeline per account · Every contact's name in one cell",
  },
  {
    id: "ai",
    mode: "ai",
    title: "The model reads the row",
    tag: "AI prompt",
    keywords:
      "ai prompt llm model gpt openai claude anthropic gemini llama mistral openrouter ollama " +
      "classify categorise categorize label score summarise summarize rewrite extract judgement " +
      "sentiment icp qualify",
    test: "The answer is in this row, but it takes judgement rather than a rule.",
    detail:
      "One model call per row, with the row's values and nothing else. It cannot look anything up — " +
      "if the answer is not already in the row it will guess rather than tell you it does not know.",
    example: "Is this job title a decision maker? · Summarise this description in five words",
  },
  {
    id: "agent",
    mode: "agent",
    title: "The model searches the web",
    tag: "AI agent",
    keywords:
      "agent web search research browse crawl scrape google serp internet online find look up " +
      "deep research tools autonomous multi step",
    test: "The answer is not in the row at all. Someone would have to go and look it up.",
    detail:
      "The model searches, opens pages, and reads them before answering — several calls per row plus " +
      "the search itself. This is the only mode that can find something the sheet does not contain, " +
      "and it is far and away the most expensive.",
    example: "Cheapest plan price from their pricing page · Which CRM do they use?",
  },
  {
    id: "mcp",
    mode: "mcp",
    title: "Ask a connected app",
    tag: "Connected app",
    keywords:
      "mcp connected app tool server model context protocol integration plugin connector external " +
      "provider lookup enrich call function stdio remote local",
    test: "An app you have connected already knows the answer, and you want to ask it once per row.",
    detail:
      "You pick one of the apps set up in Settings, choose one of its tools, and map this row's " +
      "values onto that tool's inputs. One call per row. Apps that run on your own computer never " +
      "send anything anywhere; whoever runs the app sets the price for the rest.",
    example: "Look up a company in your own database · Ask an enrichment app for a phone number",
  },
  {
    id: "wait",
    mode: "wait",
    title: "Hold the row for a while",
    tag: "Wait",
    keywords:
      "wait delay pause sleep hold poll polling async later cooldown throttle drip spacing " +
      "gap between steps give it time job queue not ready yet",
    test: "Something you called needs time before the answer is ready.",
    detail:
      "Each row sits here for the time you set, then carries on to the columns after it. Free, and " +
      "it costs nothing but the clock — an hour is the most a single column will hold a row, " +
      "because past that a scheduled run is the honest way to do it and survives a restart.",
    example: "Wait ten minutes after asking for a report, then fetch it · Space out a drip send",
  },
];

/**
 * Which modes a search finds.
 *
 * Every word typed has to appear SOMEWHERE on the card, not the whole phrase in one field. "http
 * api" is two words that happen to share the tag, but "post json webhook" spreads across the tag,
 * the keywords and the detail — matching the phrase as one string would find nothing, and "no
 * results" here reads as "this tool cannot do that", which is the wrong conclusion to hand someone
 * comparing Ferrum against Clay.
 *
 * Exported for its test rather than kept inline: the whole value of this is which words find which
 * lane, and that is a claim worth pinning rather than re-checking by hand in a browser.
 */
export function filterModes(query: string, modes: ModeSpec[] = MODES): ModeSpec[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return modes;
  return modes.filter((m) => {
    const hay = `${m.title} ${m.tag} ${m.keywords} ${m.test} ${m.detail} ${m.example}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
