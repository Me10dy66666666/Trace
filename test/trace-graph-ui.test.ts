import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

type Listener = (event: Record<string, unknown>) => void;

class FakeClassList {
  private readonly values = new Set<string>();

  add(value: string): void {
    this.values.add(value);
  }

  remove(value: string): void {
    this.values.delete(value);
  }
}

class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly classList = new FakeClassList();
  readonly listeners = new Map<string, Listener[]>();
  parent: FakeElement | null = null;
  kind: "root" | "viewport" | "card" | "detail" | "toast";
  captured = false;

  constructor(kind: FakeElement["kind"]) {
    this.kind = kind;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, event: Record<string, unknown>): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  closest(selector: string): FakeElement | null {
    if (selector.includes("[data-action]") && this.dataset.action) return this;
    if (selector.includes("[data-select]") && this.dataset.select) return this;
    if (selector.includes("button") && this.kind === "detail") return this;
    if (selector.includes(".node-card") && this.kind === "card") return this;
    return null;
  }

  setPointerCapture(): void {
    this.captured = true;
  }
}

class FakeRoot extends FakeElement {
  html = "";
  viewport: FakeElement | null = null;
  card: FakeElement | null = null;
  detail: FakeElement | null = null;
  scrollLeft = 0;
  scrollTop = 0;

  constructor() {
    super("root");
  }

  set innerHTML(value: string) {
    this.html = value;
    this.viewport = null;
    this.card = null;
    this.detail = value.includes('class="detail-panel"') ? new FakeElement("detail") : null;
    const match = value.match(/class="canvas-viewport"/);
    if (!match) return;
    this.viewport = new FakeElement("viewport");
    this.viewport.parent = this;
    this.card = new FakeElement("card");
    this.card.parent = this.viewport;
    const nodeMatch = value.match(/class="node-card[^"]*" data-node="([^"]+)"/);
    if (nodeMatch?.[1]) this.card.dataset.node = nodeMatch[1];
  }

  querySelector(selector: string): FakeElement | null {
    if (selector === ".canvas-viewport") return this.viewport;
    if (selector === ".detail-panel") return this.detail;
    return null;
  }
}

function event(target: FakeElement, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target,
    button: 0,
    clientX: 120,
    clientY: 120,
    pointerId: 1,
    preventDefault() {},
    stopPropagation() {},
    ...extra
  };
}

const graphPayload = {
  graph: {
    name: "TraceAndBack",
    branch: "main",
    status: "clean",
    nodes: [{
      id: "node-test",
      type: "version",
      title: "test node",
      createdAt: "2026-09-14T00:00:00.000Z",
      commit: "1234567890abcdef",
      parent: "—",
      changes: "test update"
    }],
    gitEdges: [],
    chronologyEdges: [],
    publishedCommit: "1234567890abcdef"
  },
  repository: { id: "repo-test", path: "D:\\TraceAndBack" },
  status: { branch: "main", dirty: false }
};

async function loadUi(): Promise<{
  root: FakeRoot;
  window: Record<string, unknown>;
  context: Record<string, unknown>;
  html: string;
}> {
  const html = await readFile(new URL("../src/mcp/trace-graph-app.html", import.meta.url), "utf8");
  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
  const root = new FakeRoot();
  const toast = new FakeElement("toast");
  const window: Record<string, unknown> = {
    addEventListener() {},
    location: {
      href: "http://127.0.0.1:4173/trace-graph-app.html?token=test&repository=D%3A%5CTraceAndBack",
      search: "?token=test&repository=D%3A%5CTraceAndBack"
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({ structuredContent: graphPayload })
    })
  };
  const document = {
    getElementById(id: string): FakeElement | null {
      return id === "app" ? root : id === "toast" ? toast : null;
    },
    querySelector(selector: string): FakeElement | null {
      return root.querySelector(selector);
    }
  };
  const context: Record<string, unknown> = {
    window,
    document,
    Element: FakeElement,
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
    console,
    Math,
    Date,
    JSON,
    URL,
    URLSearchParams,
    fetch: window.fetch
  };
  runInNewContext(script, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { root, window, context, html };
}

test("loads the Trace Graph from the top-level browser data service", async () => {
  const { root, html } = await loadUi();
  assert.ok(root.viewport);
  assert.ok(root.card);
  assert.doesNotMatch(html, /window\\.openai|window\\.parent|postMessage|MCP Apps host bridge/);
});

test("opens Trace Card details after a stationary click in the standalone browser", async () => {
  const { root, html } = await loadUi();
  assert.ok(root.viewport);
  assert.ok(root.card);
  assert.doesNotMatch(root.html, /class="graph-panel"/);
  assert.doesNotMatch(root.html, /canvas-world-shell/, "the canvas should render directly in its viewport");
  assert.match(html, /\.canvas-viewport\s*\{\s*position:\s*absolute;/, "the canvas must fill the browser workspace");
  assert.doesNotMatch(html, /window\\.openai|window\\.parent|postMessage|MCP Apps host bridge|graph-panel/);

  const viewport = root.viewport;
  const card = root.card;
  viewport.dispatch("pointerdown", event(card));
  const releaseTarget = viewport.captured ? viewport : card;
  viewport.dispatch("pointerup", event(releaseTarget));
  root.dispatch("click", event(releaseTarget));

  assert.ok(root.detail, "a stationary card click should render the detail panel");
});

test("renders Git graph edges with explicit endpoints and visible direction markers", async () => {
  const { html } = await loadUi();

  assert.match(html, /data-edge-from=/, "each edge should expose its source node");
  assert.match(html, /data-edge-to=/, "each edge should expose its target node");
  assert.match(html, /marker-start: url\(#edge-origin\)/, "each edge should show its origin");
  assert.match(html, /marker-end: url\(#arrow-git\)/, "Git edges should show their direction");
  assert.match(html, /routesByTarget/, "parallel edges should be routed into separate lanes");
});

test("keeps only the zoom controls in the graph overlay", async () => {
  const { html } = await loadUi();

  assert.match(html, /canvas-zoom-tools/, "the overlay should be dedicated to zoom controls");
  assert.doesNotMatch(html, /graph-toolbar|项目版本画布|时间关系|实现关系|relationshipMode/);
});

test("keeps detail tabs focused and gives primary content stronger hierarchy", async () => {
  const { root, html } = await loadUi();
  const card = root.card;

  assert.ok(card);
  root.dispatch("click", event(card));

  assert.doesNotMatch(root.html, /当前项目关系|class="relation-list"/, "overview should not repeat the relations tab");
  assert.match(html, /\.detail-section-primary h3/, "primary sections should have a distinct heading style");
  assert.match(html, /\.detail-section-primary p/, "primary content should have a distinct body style");
  assert.match(html, /\.detail-hint/, "secondary helper text should use a quieter style");
  assert.match(html, /font-size: 11px/, "interactive labels should remain readable");
});

test("distinguishes remote-published cards from selected cards", async () => {
  const { html } = await loadUi();

  assert.match(html, /publishedCommit/, "the UI should receive the current remote publication state");
  assert.doesNotMatch(html, /publishedCommits/, "the UI should mark only one remote version");
  assert.match(html, /published-badge/, "published versions should have a visible marker");
  assert.match(html, /node-card\.published/, "published cards need a distinct visual state");
  assert.match(html, /node-card\.selected\.published/, "selection should override the published highlight");
  assert.match(
    html,
    /\.node-card\.selected \.published-badge \{[\s\S]*color: var\(--green\)/,
    "the published label should keep its original color when selected"
  );
});

test("does not report the published marker as a repository update on every poll", async () => {
  const { context } = await loadUi();
  const repositoryRevision = context.repositoryRevision as (
    status: Record<string, unknown>,
    publishedCommit?: string | null
  ) => string | null;
  const graphStatusRevision = repositoryRevision(graphPayload.status, graphPayload.graph.publishedCommit);
  const polledStatusRevision = repositoryRevision({
    ...graphPayload.status,
    publishedCommit: graphPayload.graph.publishedCommit
  });

  assert.equal(
    graphStatusRevision,
    polledStatusRevision,
    "the initial graph and status poll must produce the same revision when the repository did not change"
  );
});

test("keeps manual refresh and enables repository status polling", async () => {
  const { html } = await loadUi();

  assert.match(html, /data-action=\\"refresh\\"/, "manual refresh must remain available");
  assert.match(html, /trace\.get_status/, "the browser should be able to check repository status");
  assert.match(html, /setInterval/, "the graph should poll for repository changes");
  assert.match(html, /automatic|自动/, "automatic refresh should be communicated in the UI");
});
