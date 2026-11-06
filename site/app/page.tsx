import { ChatRail } from "@/components/ChatRail";
import { Command } from "@/components/Command";
import { EditorDiagram } from "@/components/EditorDiagram";
import { OsTabs } from "@/components/OsTabs";
import { EXTENSION_VERSION, REPO } from "@/lib/version";

const CAPABILITIES = [
  {
    label: "chat",
    title: "Agent, Ask and Plan",
    body: (
      <>
        One session at a time, streamed token by token. <kbd>Shift+Tab</kbd>{" "}
        cycles the mode, and switching out of Plan mid-session rewrites the
        stored mode rather than starting over.
      </>
    ),
  },
  {
    label: "context",
    title: "Send what you're looking at",
    body: (
      <>
        <kbd>Ctrl+I</kbd> sends the selection, or focuses the chat when there
        isn&apos;t one. Paste or drop a screenshot. <code>@</code> searches every
        folder in the workspace; the rest are passed to the agent with{" "}
        <code>--add-dir</code>.
      </>
    ),
  },
  {
    label: "sessions",
    title: "Sessions that survive a restart",
    body: (
      <>
        Search, an <code>Active · N</code> filter, drag-and-drop groups, status
        and relative time. The oldest closed chats are pruned at your history
        limit.
      </>
    ),
  },
  {
    label: "mcp",
    title: "MCP servers and plugins",
    body: (
      <>
        Reads <code>~/.cursor/mcp.json</code> and the workspace&apos;s own. Live
        status, the tools each server exposes, enable, disable, log in, and
        local plugin folders.
      </>
    ),
  },
  {
    label: "checkpoints",
    title: "Revert a run",
    body: (
      <>
        A shadow-git checkpoint is taken before each Agent run, so you can put
        the working tree back the way it was without touching your real history.
      </>
    ),
  },
  {
    label: "backends",
    title: "Your login, or your key",
    body: (
      <>
        The CLI backend uses your Cursor subscription login. The SDK backend
        takes an API key and bills by usage. Same panel either way.
      </>
    ),
  },
];

export default function Page() {
  const version = EXTENSION_VERSION;

  return (
    <>
      <div className="shell">
        <header className="masthead">
          <span className="wordmark">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M12 2 20.66 7 12 12 3.34 7z" />
              <path fill="currentColor" fillOpacity=".62" d="M3.34 7 12 12v10l-8.66-5z" />
              <path fill="currentColor" fillOpacity=".34" d="M12 12l8.66-5v10L12 22z" />
            </svg>
            cursor&nbsp;agent
          </span>
          <nav className="masthead-links">
            <a href="#install">Install</a>
            <a href={REPO}>Source</a>
          </nav>
        </header>
      </div>

      <div className="shell shell-split">
        <main>
          <div className="hero">
            <p className="eyebrow">VS Code extension · v{version}</p>
            <h1 className="display">
              Cursor&apos;s agent,
              <br />
              <span className="quiet">in the right rail.</span>
            </h1>
            <p className="hero-lede">
              A sidebar chat that runs the <strong>Cursor CLI</strong>, laid out
              like Claude Code — so the two sit side by side and you stop
              switching editors to use one agent.
            </p>
            <div className="hero-cta">
              <Command>{`git clone ${REPO}.git`}</Command>
              <p className="hero-note">
                Not on the Marketplace. Clone it, build it, install the .vsix —
                four commands, below.
              </p>
            </div>
          </div>

          <section id="layout" data-step="3">
            <div className="panel-head">
              <h2>Where it lives</h2>
              <p>three regions</p>
            </div>
            <EditorDiagram />
          </section>

          <section id="features" data-step="5">
            <div className="panel-head">
              <h2>What it does</h2>
              <p>six panels</p>
            </div>
            <div className="panels">
              {CAPABILITIES.map((item) => (
                <article className="panel" key={item.label}>
                  <p className="eyebrow">{item.label}</p>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </article>
              ))}
            </div>
          </section>

          <section id="install" data-step="7">
            <div className="panel-head">
              <h2>Install</h2>
              <p>in order</p>
            </div>

            <ol className="steps">
              <li className="step">
                <div className="step-body">
                  <h3>Install the Cursor CLI</h3>
                  <p>
                    The chat is a front end for it, so this comes first.{" "}
                    <code>agent</code> has to be on your PATH —{" "}
                    <code>cursor-agent</code> is the same binary.
                  </p>
                  <OsTabs />
                </div>
              </li>

              <li className="step">
                <div className="step-body">
                  <h3>Log in once</h3>
                  <p>
                    Uses your Cursor subscription. Nothing is stored by the
                    extension.
                  </p>
                  <Command>agent login</Command>
                </div>
              </li>

              <li className="step">
                <div className="step-body">
                  <h3>Clone and build</h3>
                  <p>
                    Typechecks, runs the tests, builds both webviews and packages
                    the .vsix.
                  </p>
                  <Command>{`git clone ${REPO}.git`}</Command>
                  <Command>cd cursor-agent-vscode && npm install</Command>
                  <Command>npm run package</Command>
                </div>
              </li>

              <li className="step">
                <div className="step-body">
                  <h3>Install the .vsix</h3>
                  <p>Then reload VS Code and open the Cursor icon in the activity bar.</p>
                  <Command>{`code --install-extension cursor-agent-vscode-${version}.vsix`}</Command>
                  <p className="step-after">
                    Prefer to hack on it? <code>npm run watch:ext</code> and F5
                    opens an Extension Development Host instead.
                  </p>
                </div>
              </li>
            </ol>
          </section>

          <section id="requirements" data-step="9">
            <div className="panel-head">
              <h2>Before you start</h2>
              <p>the honest list</p>
            </div>
            <dl className="reqs">
              <div className="req">
                <dt>VS Code</dt>
                <dd>
                  1.100 or newer. The chat only gets its own right-hand rail on
                  1.106+; below that it appears as a second view on the left.
                </dd>
              </div>
              <div className="req">
                <dt>Node</dt>
                <dd>
                  22.18+ to build. The optional SDK backend needs 22.13+ at run
                  time.
                </dd>
              </div>
              <div className="req">
                <dt>Cursor account</dt>
                <dd>
                  Your own subscription login, or an API key for the SDK
                  backend. This is a client; it ships no credentials and no
                  quota.
                </dd>
              </div>
              <div className="req">
                <dt>Not affiliated</dt>
                <dd>
                  An independent front end for Cursor&apos;s public CLI. Not
                  built or endorsed by Cursor or Anthropic.
                </dd>
              </div>
              <div className="req">
                <dt>License</dt>
                <dd>
                  MIT. Fork it, change it, ship it —{" "}
                  <a href={`${REPO}/blob/main/LICENSE`}>read the terms</a>.
                </dd>
              </div>
            </dl>
          </section>

          <footer>
            <div className="footer-row">
              <span>MIT · v{version}</span>
              <nav>
                <a href={REPO}>GitHub</a>
                <a href={`${REPO}/blob/main/README.md`}>README</a>
                <a href={`${REPO}/tree/main/docs`}>Docs</a>
                <a href={`${REPO}/issues`}>Issues</a>
              </nav>
            </div>
          </footer>
        </main>

        <aside className="rail-slot">
          <ChatRail />
        </aside>
      </div>
    </>
  );
}
