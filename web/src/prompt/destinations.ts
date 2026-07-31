// Destination presets — the CRMs and sequencers people actually push rows into.
//
// Any HTTP API already worked. What did not exist was a starting point, so pushing a list into a
// sequencer meant reading its docs, finding the endpoint, working out whether the key goes in a
// header or a query string, whether it is `Bearer` or `Api-Key`, and what the body has to be called.
// That is twenty minutes of tab-switching before the first row moves, repeated by everyone.
//
// A preset is a FILLED-IN FORM, not a hidden integration. It writes the same `HttpConfig` a person
// would have typed, into the same editor, and every field stays editable afterwards. That matters
// for the reason every "integration" eventually disappoints: the day the provider changes its
// endpoint, a form you can edit is a two-second fix and a black box is a support ticket.
//
// THREE RULES, and they are what make this safe to ship:
//
//   1. NO KEYS HERE. Every preset references `{{secret:Name}}`, the workspace's saved-key mechanism.
//      A preset that asked you to paste a token into a column header would put it in the column, and
//      the column travels — into a duplicate, a template, an export.
//   2. NO PRICES INVENTED. `cost` is left for the user to fill in unless the provider's own pricing
//      is a fixed published number. A fabricated cost is worse than none: it shows up as a real
//      figure in the usage report and nobody re-checks it.
//   3. DATED AND UNVERIFIED. These are written from public documentation, not from a live call
//      against every provider. Endpoints move. Each carries `checked`, and the UI says plainly that
//      it is a starting point rather than a guarantee — because a preset that is quietly wrong is
//      worse than no preset, and the honest way to ship these is to say which they are.

import type { HttpConfig, Pair } from "./httpConfig.ts";

export interface Destination {
  id: string;
  /** What it is called, as the provider calls it. */
  name: string;
  /** CRM, sequencer, and so on — the grouping in the picker. */
  group: string;
  /** One line: what this preset does to one row. */
  what: string;
  /** The saved key it expects, by name. Shown so the user can go and create it first. */
  needsKey: string | null;
  /** Where to read what the fields mean. */
  docsUrl: string;
  /** When the shape below was last written from those docs. Shown, because it ages. */
  checked: string;
  /** Applied over DEFAULT_HTTP. Everything stays editable afterwards. */
  config: Partial<HttpConfig>;
  /** Fields the user must fill in themselves — listed so the form does not look finished when it is
   *  not. Each names a field of the config by label, not by key. */
  fillIn: string[];
}

const json = (fields: Array<[string, string]>): Pair[] => fields.map(([name, value]) => ({ name, value }));

/**
 * `/Column` references, deliberately.
 *
 * The editor resolves these to real column references as soon as the preset is applied, so a preset
 * arrives pointing at the user's own columns where the names happen to match and shows an unresolved
 * reference where they do not — which is the visible, fixable state. The alternative, leaving the
 * values blank, produces a form that looks configured and sends empty fields.
 */
export const DESTINATIONS: Destination[] = [
  {
    id: "webhook",
    name: "Any webhook",
    group: "Generic",
    what: "POSTs the row as JSON to a URL you choose.",
    needsKey: null,
    docsUrl: "",
    checked: "2026-07-31",
    config: {
      method: "POST",
      bodyMode: "json",
      bodyFields: json([["email", "/Email"], ["name", "/Name"], ["company", "/Company"]]),
      // Fire-and-forget: a webhook's response is almost never a value worth putting in the cell, and
      // waiting on one turns a delivery into a column of response bodies.
      fireAndForget: true,
    },
    fillIn: ["URL"],
  },
  {
    id: "slack",
    name: "Slack",
    group: "Generic",
    what: "Posts one message per row into a Slack channel.",
    needsKey: null,
    docsUrl: "https://api.slack.com/messaging/webhooks",
    checked: "2026-07-31",
    config: {
      method: "POST",
      bodyMode: "json",
      bodyFields: json([["text", "New row: /Company — /Email"]]),
      fireAndForget: true,
    },
    // The incoming-webhook URL IS the credential, which is why it is a saved key rather than a
    // typed-in URL: anyone holding that URL can post to the channel.
    fillIn: ["URL — your incoming-webhook address, ideally saved as a key"],
  },
  {
    id: "hubspot-contact",
    name: "HubSpot — create or update a contact",
    group: "CRM",
    what: "Upserts one contact per row, matched on email.",
    needsKey: "HubSpot",
    docsUrl: "https://developers.hubspot.com/docs/api/crm/contacts",
    checked: "2026-07-31",
    config: {
      method: "POST",
      url: "https://api.hubapi.com/crm/v3/objects/contacts",
      headers: json([["Authorization", "Bearer {{secret:HubSpot}}"]]),
      bodyMode: "raw",
      // Raw rather than fields: HubSpot nests everything under `properties`, and the fields editor
      // assembles a FLAT object. Pretending otherwise would produce a body the API rejects with a
      // message that does not mention nesting.
      body: '{\n  "properties": {\n    "email": "/Email",\n    "firstname": "/First name",\n    "lastname": "/Last name",\n    "company": "/Company"\n  }\n}',
      responsePath: "id",
    },
    fillIn: ["A saved key called HubSpot", "Check the property names against your own portal"],
  },
  {
    id: "pipedrive-person",
    name: "Pipedrive — create a person",
    group: "CRM",
    what: "Creates one person per row.",
    needsKey: "Pipedrive",
    docsUrl: "https://developers.pipedrive.com/docs/api/v1/Persons",
    checked: "2026-07-31",
    config: {
      method: "POST",
      url: "https://api.pipedrive.com/v1/persons",
      // Pipedrive takes its token in the query string. Written as a reference, so the token itself
      // is still never in the column.
      query: json([["api_token", "{{secret:Pipedrive}}"]]),
      bodyMode: "json",
      bodyFields: json([["name", "/Name"], ["email", "/Email"]]),
      responsePath: "data.id",
    },
    fillIn: ["A saved key called Pipedrive"],
  },
  {
    id: "attio-record",
    name: "Attio — upsert a person",
    group: "CRM",
    what: "Creates or updates one person record per row, matched on email.",
    needsKey: "Attio",
    docsUrl: "https://developers.attio.com/reference",
    checked: "2026-07-31",
    config: {
      method: "PUT",
      url: "https://api.attio.com/v2/objects/people/records",
      headers: json([["Authorization", "Bearer {{secret:Attio}}"]]),
      bodyMode: "raw",
      body: '{\n  "data": {\n    "values": {\n      "email_addresses": ["/Email"],\n      "name": [{ "full_name": "/Name" }]\n    }\n  }\n}',
      responsePath: "data.id.record_id",
    },
    fillIn: ["A saved key called Attio", "Confirm the attribute slugs in your own workspace"],
  },
  {
    id: "instantly-lead",
    name: "Instantly — add a lead to a campaign",
    group: "Sequencer",
    what: "Adds one lead per row to a campaign you name.",
    needsKey: "Instantly",
    docsUrl: "https://developer.instantly.ai/",
    checked: "2026-07-31",
    config: {
      method: "POST",
      url: "https://api.instantly.ai/api/v2/leads",
      headers: json([["Authorization", "Bearer {{secret:Instantly}}"]]),
      bodyMode: "json",
      bodyFields: json([
        ["campaign", ""],
        ["email", "/Email"],
        ["first_name", "/First name"],
        ["last_name", "/Last name"],
        ["company_name", "/Company"],
      ]),
    },
    fillIn: ["A saved key called Instantly", "The campaign id, in the `campaign` field"],
  },
  {
    id: "smartlead-lead",
    name: "Smartlead — add leads to a campaign",
    group: "Sequencer",
    what: "Adds one lead per row to a campaign you name.",
    needsKey: "Smartlead",
    docsUrl: "https://api.smartlead.ai/reference",
    checked: "2026-07-31",
    config: {
      method: "POST",
      url: "https://server.smartlead.ai/api/v1/campaigns/CAMPAIGN_ID/leads",
      query: json([["api_key", "{{secret:Smartlead}}"]]),
      bodyMode: "raw",
      // Smartlead takes an ARRAY of leads. One row per call is one-element array — which is worth
      // saying, because the endpoint name is plural and reads as though it wants the whole list.
      body: '{\n  "lead_list": [\n    {\n      "email": "/Email",\n      "first_name": "/First name",\n      "last_name": "/Last name",\n      "company_name": "/Company"\n    }\n  ]\n}',
    },
    fillIn: ["A saved key called Smartlead", "Replace CAMPAIGN_ID in the URL"],
  },
  {
    id: "lemlist-lead",
    name: "lemlist — add a lead to a campaign",
    group: "Sequencer",
    what: "Adds one lead per row to a campaign you name.",
    needsKey: "lemlist",
    docsUrl: "https://developer.lemlist.com/",
    checked: "2026-07-31",
    config: {
      method: "POST",
      url: "https://api.lemlist.com/api/campaigns/CAMPAIGN_ID/leads/EMAIL",
      query: json([["access_token", "{{secret:lemlist}}"]]),
      bodyMode: "json",
      bodyFields: json([["firstName", "/First name"], ["lastName", "/Last name"], ["companyName", "/Company"]]),
    },
    fillIn: ["A saved key called lemlist", "Replace CAMPAIGN_ID and EMAIL in the URL"],
  },
];

/** Merge a preset over the defaults. Kept here so the editor has one way to apply one. */
export function applyDestination(base: HttpConfig, d: Destination): HttpConfig {
  return { ...base, ...d.config };
}

export const DESTINATION_GROUPS = [...new Set(DESTINATIONS.map((d) => d.group))];
