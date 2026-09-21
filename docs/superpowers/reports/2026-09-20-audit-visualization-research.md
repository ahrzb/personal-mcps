# How people visualize and explore logs — and which of it applies to `/audit` (2026-09-20)

> **Why this exists.** A Loki-shaped concept for `/audit` was drawn, prototyped, tested against a live
> Grafana + Loki with our own events, and rejected by the owner. This report is the research that
> should have come first: the approaches people have actually built for exploring event data, each
> traced to a source, each scored against our data rather than against a generic "logs" use case.
>
> **Sources.** Four parallel research passes (academic event-sequence literature, industry
> observability concepts, interaction-design patterns, unconventional/ambient forms), each required
> to cite a URL per claim and to mark what it could not verify. Claims the passes flagged as
> unverified are marked here too — § 7 lists them. Nothing below was taken from memory.
>
> **The dataset every score is against.** ~1,300 events/week (~185/day, ~68k/year), one owner. Per
> event: timestamp, principal, event type, app, tool, outcome (`ok` / `-32000..-32003` / `error`),
> duration, client, session id, and for `tools/call` optional nested request/response JSON, each
> capped at 16 KB by `AUDIT_BODY_CAP_BYTES` with an oversize body replaced whole by a typed stub.
> Owner questions: what did my agents do · what was refused and why · what changed my config · what
> happened in this session · is anything abnormal.

## 1. The calibration that decides everything

Three of the four passes returned the same warning unprompted: **the published machinery targets a
scale we do not have.** Sequence Synopsis, DecisionFlow, MatrixWave, Segmentifier, conformance
checking, log-template mining and ML anomaly detection all exist because someone had thousands of
event types or millions of records. We have ~17 event types and 185 events a day.

Two consequences, and they are the whole report:

1. **Anything whose purpose is summarisation-under-scale scores low.** At our volume the owner can
   read the raw rows; a summariser that takes longer to interpret than the data is a loss. The
   comparative evaluation of summarisation techniques found Sequence Synopsis produced the best
   summaries *and took participants significantly longer to interpret*
   ([arXiv 2306.02489](https://arxiv.org/abs/2306.02489)).
2. **The leverage is in interaction, not in visual form.** The field's own survey organises this
   literature along four dimensions and puts alignment, filter/query, aggregation and emphasis in
   the *interaction* dimension rather than the representation one
   ([Guo et al., TVCG 2021](https://arxiv.org/abs/2006.14291)). Our five owner questions are all
   selection questions.

The same conclusion arrived from the opposite end: the pass that hunted for imaginative,
non-list forms reported that everything scoring well was *"a list, but with better rows"*.

## 2. What survives at our scale

Ordered by what they buy us, with the failure mode that bounds each.

### 2.1 Merge the rows before adding any chrome

Monzo rebuilt their home-screen activity feed by *deleting* rows: transfers between a user's own
accounts collapse into a single item, and the account badge appears only when the user has more
than one account
([Monzo](https://monzo.com/blog/how-we-unified-our-customers-activity-on-the-new-home-screen)).

For us: a `tools/call` that triggers `approval.requested`, the owner's `approval.approved` and the
retried call are **one row with a state**, not four rows. The `app` column disappears when a filter
has already fixed the app.

*Bounds it:* an audit trail is a forensic record. Merging must be reversible — the merged row has to
be expandable into its constituent events, or we have traded the property that makes it an audit log.

### 2.2 `outcome` is too coarse — refusals need a source

Claude Code's own OpenTelemetry schema separates a tool decision's `decision_type` (accept/reject)
from its `decision_source`: config, hook, user_permanent, user_temporary, user_abort, user_reject
([Claude Code monitoring docs](https://code.claude.com/docs/en/monitoring-usage)).

We record `-32001` (not permitted), `-32002` (archived), `-32003` (approval required) — which is a
*mechanism*, not a *reason*. "Denied by a grant you set", "denied because the app is archived",
"denied because you rejected it once" are three different answers to the question the page exists to
answer, and today two of them look identical in the outcome column.

*This is a data-model question, not a layout one*, which is why it belongs in § 6.

### 2.3 Selection-versus-baseline field ranking (the useful half of BubbleUp)

Select any subset; split everything into selection and baseline; for every field compare the value
distributions and rank fields by divergence — "these 40 events are 95% `agent:cron`, versus 7% at
baseline" ([Honeycomb docs](https://docs.honeycomb.io/investigate/analyze/detect-anomalies/)).

Two findings matter here. First, **it does not need the heatmap** — any selection works: a time
brush, a filter, "all denials this week". Second, Honeycomb's marketing calls it machine learning
while the docs describe a plain proportion comparison; the useful algorithm is the simple one. With
nine low-cardinality fields it is a few lines of counting, and it is the most direct answer we have
to "is anything abnormal".

*Bounds it:* correlation only, noisy on small selections, and junk-drawer fields (session id,
timestamp) dominate the ranking unless excluded.

### 2.4 Alignment — the cheapest insight in the literature

LifeLines2's central move: choose a sentinel event, set t=0 to it, and stack records around it so
before/after structure becomes comparable across records
([Wang et al., CHI 2008](http://www.cs.umd.edu/hcil/lifelines2/)).

Align sessions on `approval.requested`, or on `admin.grant_set`, and "what was refused and why" and
"what changed my config" stop being reconstruction work. The academic pass rated this the highest
insight-per-line-of-code item in its entire list, precisely because our row count (tens of sessions
a week) sits in the form's sweet spot rather than above it.

*Bounds it:* needs a record unit (session id, or principal-day) and runs out of colour past ~8–10
event types.

### 2.5 Session as a waterfall — with salience

"What happened in this session" is a trace question, and our session ids are trace ids. But the
failure mode is documented and is *exactly* our shape: in Jaeger's own tracker, for agent traces,
"the more work an agent does, the more infrastructure spans sit between the steps you care about",
with every span rendered at equal weight
([jaeger-ui#4272](https://github.com/jaegertracing/jaeger-ui/issues/4272)).

So a session view must encode **salience**: collapse runs of `ok`, keep denials, approvals and
config changes at full weight. Sessions are small, so we get the waterfall's benefit and skip the
scaling pain that breaks Jaeger past a few hundred spans.

### 2.6 A faceted rail with exhaustive counts, and no query language

Faceted browsing's rule, from the Flamenco work, is that every facet value carries its count *in the
current result set* and zero-count values are removed — the interface only offers refinements that
lead somewhere ("avoidance of empty result sets"), and each applied filter is individually removable
([Hearst, Search User Interfaces ch. 8](https://searchuserinterfaces.com/book/sui_ch8_navigation_and_search.html)).
At our corpus size exhaustive counts are one `GROUP BY`, so we get the guarantee for free.

The matching argument against the lazy alternative: a system exposing only a query language makes
exploration "close to impossible", because you cannot filter or group by fields you do not know
exist — the ex-Meta account of Scuba, whose thesis is that *explorability* is the feature
([Burmistrov](https://isburmistrov.substack.com/p/all-you-need-is-wide-events-not-metrics)).

And the counter-evidence against building both: Grafana's Builder/Code toggle is a one-way door —
"changes made to a query in Code mode don't transfer to Builder mode and are discarded"
([Grafana docs](https://grafana.com/docs/grafana/latest/datasources/mysql/query-editor/)) — while
SigNoz's users abandoned a builder that could not express OR and parentheses, and the fix that
brought them back was a *more expressive builder*, not a language
([SigNoz](https://signoz.io/blog/query-builder-v5/)).

*Bounds it:* session id must not be a facet. Above a few dozen values a checkbox list stops working
and the prescribed replacement is top-N plus a search box over the facet's own values
([Meilisearch](https://www.meilisearch.com/docs/capabilities/filtering_sorting_faceting/how_to/handle_large_facet_cardinality)).
Session id is a link out of a record, not a rail entry.

### 2.7 The record detail, laid out like a request inspector

Chrome DevTools splits one exchange by *kind* of content — Headers, Payload, Preview, Response,
Initiator, Timing — and two rules carry most of the value: rendered and raw are both always
available one click apart, and one search spans request headers, payload and response
([DevTools reference](https://developer.chrome.com/docs/devtools/network/reference)).

Our record maps almost 1:1 — metadata, request JSON, response JSON, duration, client+session. Stripe
adds the cross-link discipline: a record is a hub, not a leaf, and every id in it links back into the
list as a filter ([Stripe Workbench](https://docs.stripe.com/workbench/overview)). Stripe also
already ships MCP tool-call logs — status, arguments, response, filterable by tool and client —
which is the closest shipped analogue to our page that the research found.

For the bodies themselves, Firefox's JSON viewer is the conservative reference: arrays and objects
collapsed by default, expandable, with a filter box and a separate raw tab
([MDN/Firefox docs](https://firefox-source-docs.mozilla.org/devtools-user/json_viewer/index.html)).

*Bounds it:* tab proliferation. Three of seven tabs empty is worse than one scrollable pane with
headings — most of our events have no bodies at all.

### 2.8 Count the disclosure levels

Nielsen's rule is a hard cap: more than two levels of progressive disclosure has low usability,
because "users often get lost when moving between the levels"
([NN/g](https://www.nngroup.com/articles/progressive-disclosure/)).

The interaction pass pointed out that our shape routinely violates it: list → row expander → drawer →
JSON tree → nested node is four or five levels. So the JSON tree's own expand/collapse must be
in-place and non-navigational, or the budget is blown.

Related, and it argues against the pattern we half-built already: details-on-demand means the detail
appears *without leaving the overview*, so the user never loses their place
([Shneiderman 1996](https://www.cs.umd.edu/~ben/papers/Shneiderman1996eyes.pdf)). The decision tree
for where detail lives puts read-only inspection with list-state preservation in a **side drawer**,
not a modal and not a page, with the caveat that deep-linking pulls the other way
([Friedman/Neufeld](https://www.smashingmagazine.com/2026/03/modal-separate-page-ux-decision-tree/)).

### 2.9 Calendar / punchcard as navigation, not decoration

Both the academic and the unconventional pass landed on this independently. The academic ancestor
bins activity into day cells and colours by an intra-day profile cluster
([van Wijk & van Selow, InfoVis 1999](https://vanwijk.win.tue.nl/clv.pdf)); the popular descendants
are the contribution graph and the weekday × hour punchcard.

Its real argument is that **it shows absence** — the gap where cron stopped is visible, and no list
shows a gap. Its real limitation is that one cell carries one scalar, so it cannot carry outcome;
and GitHub shipping, then removing, the punchcard is evidence about how often people return to it.

Verdict from both passes: worth it as a **date picker** (click a day, filter the list), not as the
page's main visualisation.

### 2.10 A per-principal state timeline

One lane per principal, coloured by outcome, with consecutive equal values merged — Grafana's state
timeline is the shipped reference
([docs](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/state-timeline/)).
Three lanes (`agent:claude`, `agent:cron`, `user:ahrzb`) makes "cron was denied all Tuesday" a block
you see rather than a pattern you reconstruct. The merge of equal consecutive values is what keeps it
legible at 1,300 events.

*Bounds it:* instantaneous events render as invisible slivers, which tempts you into faking
durations for events that have none.

### 2.11 The layout law, and the cheapest possible build

"Overview first, zoom and filter, then details-on-demand", with *history* (an undoable breadcrumb of
applied filters) as a first-class task rather than an extra
([Shneiderman 1996](https://ieeexplore.ieee.org/document/545307)). The empirical follow-up worth
knowing: plain overview+detail frequently *beats* focus+context distortion, which is both cheaper and
less disorienting ([Cockburn et al., CSUR 2009](https://www.microsoft.com/en-us/research/wp-content/uploads/2008/01/cockburn-ComputingSurveys09.pdf)).

And the floor of the whole space: GoAccess answers a closed dimension set with a fixed panel of
top-N lists and no query surface at all ([GoAccess](https://goaccess.io/features)). Our dimensions
*are* closed — principal × type × app × tool × outcome. A one-screen "this week" of five top-N panels
plausibly answers most of "what did my agents do / what got refused" with zero interaction, and is
the cheapest item in this report.

## 3. What to skip, with the reason

| Approach | Why not |
|---|---|
| Log pattern / template mining (Drain, Spell; Grafana/Splunk/Datadog Patterns) | Solves turning unstructured text into categories. Our events are already typed — it is a `GROUP BY` we get free. Every implementation is also approximate and sampled: Grafana's patterns are mined only from the previous three hours, Datadog's from 10 000 samples. Steal only the include/exclude-to-subtract-the-known interaction. |
| Log-rate analysis, change-point detection, ML anomaly detection | Needs volume for significance. At 185 events/day, an anomaly detector mostly discovers that the owner took a weekend off. Three hand-written rules (first-ever call of a tool, first denial for a principal, error rate above last week) cover the real cases. |
| Latency heatmap | One numeric field and ~185 events/day means most cells hold 0–2 events; it renders as confetti. Keep the lasso-then-rank interaction (§ 2.3), drop the heatmap. |
| Flame graph | The x axis is stack population, not time, and it needs call-stack depth we do not have. |
| Streamgraph / ThemeRiver | Only the bottom band has a straight baseline, so rare categories are hairlines — and `error` and `admin.grant_set` are exactly the rare categories we care about. |
| Horizon charts | Solve vertical-space scarcity across dozens of parallel series. We have a handful of series and a whole page. |
| Storyline charts, spiral time, pixel-oriented views | Structurally inapplicable (our principals never converge), or aimed at 100k+ records. |
| Logstalgia, Gource, sonification | Ambient monitoring presumes a continuous watcher; our owner reads this page occasionally. The one transferable bit: a denial should be perceptible without reading. |
| Virtualised JSON trees | Breaks Ctrl+F, anchors and text selection to buy a frame rate we do not need at 16 KB. |
| A code-mode query language | See § 2.6 — the evidence says an expressive builder beats a builder-plus-language. |

## 4. Where the passes disagreed

- **Drawer versus deep link.** Details-on-demand and the decision tree both point at a side drawer;
  "what happened in this session" wants a real URL. The common resolution — a drawer that also owns a
  URL — has no published evidence behind it (§ 7).
- **Digest versus page.** One pass argued a weekly digest beats the page outright, because a page read
  "occasionally" loses to a mail that arrives on its own (Sentry's weekly reports as the reference),
  and countered itself: a digest that says "all normal" becomes filtered noise within two months. The
  resolution it proposed is to send only on deltas.
- **How much the field rail helps *this* user.** Scented-widget evidence says embedded counts roughly
  doubled unique discoveries for users exploring *unfamiliar* data, and that the advantage
  equalises as familiarity grows ([Willett et al., InfoVis 2007](http://vis.stanford.edu/papers/scented-widgets)).
  Our user is maximally familiar. Counts still pay for themselves as the dead-end guarantee, but
  sparklines and histograms in the rail would not.

## 5. The shortlist

Ranked by value per unit of work, from the union of the four passes:

1. **Better rows** — merge a call with its approval and resolution (§ 2.1); keep the typed record, never re-render it as a text line.
2. **Faceted rail with exhaustive counts, session id excluded** (§ 2.6), client-side so updates land under 100 ms.
3. **Record detail as a request inspector in a side drawer** — metadata / request / response / timing, rendered↔raw, one search across the record, ids as links back into the list (§ 2.7), within a two-level disclosure budget (§ 2.8).
4. **Selection → rank every field by divergence from baseline** (§ 2.3) — the "is anything abnormal" answer, a few lines of counting.
5. **Session view with salience** (§ 2.5) — collapse `ok` runs, keep refusals and config changes full weight.
6. **A time strip that brushes** (§ 2.10, § 2.11) — per-principal lanes coloured by outcome, brushing filters the table; a calendar strip as the date picker (§ 2.9).
7. **Alignment on a sentinel event** (§ 2.4) — the highest-insight, least-obvious item; probably a second-pass feature.

## 6. Owner questions

Two are product decisions, not execution ones:

1. **Does `outcome` split into mechanism and reason?** (§ 2.2) Adding a `decision_source`-like field is
   a data-model and spec change (§ 15), not a UI change, and everything about how legible refusals are
   downstream depends on it.
2. **Is a weekly digest in scope at all?** (§ 4) If yes, the page's job shrinks to being where the
   digest links to, which changes what belongs above the fold.

## 7. Flagged as unverified

Carried forward from the passes, so nobody treats them as settled: the seven-task wording of
Shneiderman's taxonomy (secondary sources only); that a "drawer that owns a URL" is an established
resolution; that collapsed JSON nodes conventionally show element counts and byte sizes (widely
implemented, no primary rule found); Splunk's Patterns tab running `cluster` underneath (forum claim);
the punchcard as a citable academic form (use the calendar paper instead); Zui's detail-pane
behaviour; mitmproxy's pretty/raw content views; and the existence of a first-party Anthropic console
trace viewer showing tool-call arguments and results — none was found.

Also worth recording as method: the strongest advocates of "wide events" and the strongest critics of
text logs are, in every case the passes found, people selling an alternative. Their *mechanisms*
check out; their conclusions are load-bearing for their products. And no canonical, independent
critique of the list-plus-histogram convention exists — the defensible version of that claim is only
that the list should be details-on-demand rather than the entry point.
