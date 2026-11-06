"use client";

import { useEffect, useState } from "react";
import { SESSION, type Event } from "@/lib/session-script";

/** The cube, at icon size. */
function CubeMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M12 2 20.66 7 12 12 3.34 7z" />
      <path fill="currentColor" fillOpacity=".62" d="M3.34 7 12 12v10l-8.66-5z" />
      <path fill="currentColor" fillOpacity=".34" d="M12 12l8.66-5v10L12 22z" />
      <path fill="currentColor" fillOpacity=".9" d="M12 12l8.66-5L15.2 18.85z" />
    </svg>
  );
}

function EventLine({ event }: { event: Event }) {
  switch (event.kind) {
    case "user":
      return (
        <span>
          <span className="ev-mode">{event.mode}</span>
          {event.text}
        </span>
      );
    case "tool":
      return (
        <span>
          <span className="tool">{event.tool}</span>
          {event.arg ? <> <span className="arg">{event.arg}</span></> : null}
        </span>
      );
    case "edit":
      return (
        <span>
          <span className="tool">{event.tool}</span>{" "}
          <span className="arg">{event.arg}</span>
          <span className="ev-diff">
            <span className="add">+{event.add}</span>
            <span className="del">−{event.del}</span>
          </span>
        </span>
      );
    case "run":
      return (
        <span className="ev-run">
          <span className="pulse" />
          running
        </span>
      );
    case "note":
      return <span className="arg">{event.text}</span>;
    case "assistant":
      return <span>{event.text}</span>;
  }
}

export function ChatRail() {
  const [revealed, setRevealed] = useState(0);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduce.matches) {
      setRevealed(SESSION.length);
      return;
    }

    // Each section of the page carries a sentinel; passing one advances the
    // session. The page's own scroll is the clock.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const step = Number(
            (entry.target as HTMLElement).dataset.step ?? "0",
          );
          setRevealed((current) => Math.max(current, step));
        }
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );

    const marks = document.querySelectorAll<HTMLElement>("[data-step]");
    marks.forEach((mark) => observer.observe(mark));

    // Open on the first turn so the rail is never empty.
    const opening = window.setTimeout(() => {
      setRevealed((current) => Math.max(current, 2));
    }, 450);

    return () => {
      observer.disconnect();
      window.clearTimeout(opening);
    };
  }, []);

  return (
    <div>
      <div className="rail" aria-hidden="true">
        <div className="rail-head">
          <CubeMark />
          <span className="rail-title">Cursor</span>
          <span className="rail-chip">sonnet</span>
        </div>

        <div className="rail-body">
          {SESSION.map((event, index) => (
            <div
              key={index}
              className={`ev${event.kind === "assistant" ? " ev-assistant" : ""}`}
              data-kind={event.kind}
              data-shown={index < revealed}
              style={{ transitionDelay: `${Math.min(index, 4) * 40}ms` }}
            >
              <div className="ev-gutter">
                <span className="ev-dot" />
              </div>
              <div className="ev-line">
                <EventLine event={event} />
              </div>
            </div>
          ))}
        </div>

        <div className="rail-composer">
          <div className="rail-composer-chips">
            <span className="chip">Composer.tsx:40-58</span>
            <span className="chip">@store.ts</span>
          </div>
          <div className="rail-composer-line">
            <span>Plan, search, build…</span>
            <span className="caret" />
          </div>
          <div className="rail-composer-foot">
            <span>⇧⇥ agent · ask · plan</span>
            <span>@ ⧉ ⏎</span>
          </div>
        </div>
      </div>

      <p className="rail-caption">Not a screenshot. Scroll to run it.</p>
      <p className="sr-only">
        A mock of the extension&apos;s chat panel. It shows a session where the
        agent reads six files, greps for a CSS class, edits two files, runs the
        test suite, and reports what the bug was.
      </p>
    </div>
  );
}
